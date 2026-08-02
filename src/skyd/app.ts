import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SlackStartupError, startBotRuntime, type BotRuntime } from '../bot.js';
import {
  createRuntimeController,
  type RuntimeController,
  type SupervisionMode,
} from '../runtime/controller.js';
import { computeBackoffMs, isAbortError, sleep, type BackoffOptions } from '../runtime/retry.js';
import type { Settings } from '../settings.js';
import {
  createSkyHome,
  prepareSkyHome,
  type SkyHome,
} from '../sky-home.js';
import { startControlServer, type ControlServer } from './control.js';
import { createJsonlLogger, type JsonlLoggerOptions } from './logger.js';
import { createMaintenanceOperationRunner } from './maintenance.js';
import {
  createOperationRegistry,
  type OperationRegistry,
  type OperationRunner,
} from './operations.js';
import { ConfigurationError, loadSecureSettings } from './settings.js';
import type { DaemonStatus, RuntimeState, SlackConnectionState } from './types.js';
import { runDiagnostics } from '../diagnostics.js';

const { version: PRODUCT_VERSION } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

export type RuntimeStarter = (
  settings: Settings,
  runtimeController: RuntimeController,
  skyHome: SkyHome,
) => Promise<BotRuntime>;

export type StartSkydOptions = {
  skyHome?: SkyHome;
  rootDir?: string;
  homeDir?: string;
  productVersion?: string;
  startRuntime?: RuntimeStarter;
  backoff?: BackoffOptions;
  random?: () => number;
  logger?: JsonlLoggerOptions;
  supervisionMode?: SupervisionMode;
  restartDrainTimeoutMs?: number;
  stopDrainTimeoutMs?: number;
  runOperation?: OperationRunner;
  operationRegistry?: {
    completedLimit?: number;
    retentionMs?: number;
    eventLimit?: number;
    now?: () => Date;
    createId?: () => string;
  };
};

export type Skyd = {
  paths: SkyHome;
  status(): DaemonStatus;
  finished: Promise<void>;
  close(): Promise<void>;
};

type MutableStatus = {
  runtimeState: RuntimeState;
  slackState: SlackConnectionState;
  slackAttempts: number;
  nextRetryAt: string | null;
  backend: 'pi' | 'claude-agent-sdk' | null;
  model: string | null;
  recentErrors: Array<{ code: string; at: string }>;
};

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function causeMessage(error: SlackStartupError): string {
  return error.cause instanceof Error ? error.cause.message : String(error.cause ?? error.message);
}

export async function startSkyd(options: StartSkydOptions = {}): Promise<Skyd> {
  process.umask(0o077);
  const paths =
    options.skyHome ?? createSkyHome({ rootDir: options.rootDir, homeDir: options.homeDir });
  prepareSkyHome(paths);
  const instanceId = randomUUID();
  const logger = createJsonlLogger(paths.logFile, {
    ...options.logger,
    instanceId,
  });
  const startedAt = new Date();
  const runtimeController = createRuntimeController({
    supervisionMode: options.supervisionMode ?? 'foreground',
    restartTimeoutMs: options.restartDrainTimeoutMs,
    stopTimeoutMs: options.stopDrainTimeoutMs,
  });
  const mutable: MutableStatus = {
    runtimeState: 'starting',
    slackState: 'not_configured',
    slackAttempts: 0,
    nextRetryAt: null,
    backend: null,
    model: null,
    recentErrors: [],
  };
  let activeSettings: Settings | undefined;
  let runtime: BotRuntime | undefined;
  const operations: OperationRegistry = createOperationRegistry({
    runtimeController,
    logger,
    run: options.runOperation ?? createMaintenanceOperationRunner(paths, logger),
    ...options.operationRegistry,
  });

  const addError = (code: string) => {
    mutable.recentErrors = [...mutable.recentErrors, { code, at: new Date().toISOString() }].slice(-10);
  };

  const status = (): DaemonStatus => ({
    instanceId,
    supervision: { mode: runtimeController.supervisionMode },
    process: {
      pid: process.pid,
      state: runtimeController.isAccepting() ? 'running' : 'stopping',
      startedAt: startedAt.toISOString(),
      uptimeMs: Math.max(0, Date.now() - startedAt.getTime()),
    },
    runtime: {
      state: runtimeController.isAccepting() ? mutable.runtimeState : 'draining',
    },
    productVersion: options.productVersion ?? PRODUCT_VERSION,
    slack: {
      state: mutable.slackState,
      attempts: mutable.slackAttempts,
      nextRetryAt: mutable.nextRetryAt,
    },
    agent: {
      backend: mutable.backend,
      model: mutable.model,
    },
    activeWorkCount: runtimeController.activeCount(),
    recentErrors: [...mutable.recentErrors],
  });

  let controlServer: ControlServer;
  try {
    controlServer = await startControlServer(paths.socketFile, status, {
      requestRestart: () => {
        const result = runtimeController.requestRestart(() => {
          try {
            loadSecureSettings(paths);
            return undefined;
          } catch (error) {
            if (error instanceof ConfigurationError) {
              return { code: error.code, message: error.message };
            }
            throw error;
          }
        });
        return result.ok
          ? { ok: true, instanceId }
          : { ok: false, code: result.code, message: result.message, statusCode: 409 };
      },
      operations,
      logger,
      getDiagnostics: () =>
        runDiagnostics(paths, {
          daemonStatus: status(),
          activeSettings,
          homeDir: options.homeDir,
        }),
    });
  } catch (error) {
    logger.log('error', 'control', error instanceof Error ? error.message : String(error));
    throw error;
  }
  logger.log('info', 'daemon', 'Control interface started.');

  const startRuntime = options.startRuntime ?? startBotRuntime;
  const runtimeTask = (async () => {
    let settings: Settings;
    try {
      settings = loadSecureSettings(paths);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      mutable.runtimeState = 'needs_configuration';
      mutable.slackState = 'not_configured';
      addError(error.code);
      logger.log('warn', 'settings', error.message);
      await waitForAbort(runtimeController.drainingSignal);
      return;
    }

    activeSettings = settings;

    mutable.backend = settings.agentBackend;
    mutable.model = settings.model;
    logger.protect([
      settings.slack.botToken,
      settings.slack.appToken,
      settings.claudeAgentSdk?.oauthToken ?? '',
    ]);

    let attempt = 0;
    while (!runtimeController.drainingSignal.aborted) {
      mutable.runtimeState = attempt === 0 ? 'starting' : 'degraded';
      mutable.slackState = attempt === 0 ? 'connecting' : 'retrying';
      mutable.nextRetryAt = null;

      try {
        runtime = await startRuntime(settings, runtimeController, paths);
      } catch (error) {
        if (!(error instanceof SlackStartupError)) throw error;
        attempt += 1;
        mutable.runtimeState = 'degraded';
        mutable.slackState = 'retrying';
        mutable.slackAttempts = attempt;
        addError('slack_startup_failed');
        const delayMs = computeBackoffMs(attempt, options.backoff, options.random);
        mutable.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
        logger.log('error', 'slack', `Slack startup failed: ${causeMessage(error)}`);
        try {
          await sleep(delayMs, runtimeController.drainingSignal);
        } catch (sleepError) {
          if (!isAbortError(sleepError)) throw sleepError;
        }
        continue;
      }

      mutable.runtimeState = 'ready';
      mutable.slackState = 'connected';
      mutable.nextRetryAt = null;
      logger.log('info', 'runtime', 'Slack and agent runtime started.');
      await waitForAbort(runtimeController.drainingSignal);
      return;
    }
  })().catch((error) => {
    addError('internal_error');
    logger.log('error', 'daemon', error instanceof Error ? error.message : String(error));
    throw error;
  });

  const lifecycleTask = (async () => {
    let runtimeError: unknown;
    try {
      await runtimeTask;
    } catch (error) {
      runtimeError = error;
      runtimeController.requestStop();
    }

    mutable.runtimeState = 'draining';
    mutable.nextRetryAt = null;
    const drain = await runtimeController.drain();
    if (drain.timedOut) {
      addError('drain_timeout');
      logger.log('warn', 'runtime', 'Drain deadline exceeded; aborting remaining activity.');
      operations.cancelActive();
    }
    await runtime?.close();
    runtime = undefined;
    mutable.slackState = 'stopped';
    await controlServer.close();
    runtimeController.finish();
    logger.log('info', 'daemon', 'Daemon stopped.');
    if (runtimeError) throw runtimeError;
  })();

  return {
    paths,
    status,
    finished: lifecycleTask,
    close() {
      runtimeController.requestStop();
      return lifecycleTask;
    },
  };
}
