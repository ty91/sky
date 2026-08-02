import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SlackStartupError, startBotRuntime, type BotRuntime } from '../bot.js';
import { computeBackoffMs, isAbortError, sleep, type BackoffOptions } from '../runtime/retry.js';
import type { Settings } from '../settings.js';
import { startControlServer, type ControlServer } from './control.js';
import { createJsonlLogger, type JsonlLoggerOptions } from './logger.js';
import { prepareSkydPaths, type SkydPaths } from './paths.js';
import { ConfigurationError, loadSecureSettings } from './settings.js';
import type { DaemonStatus, RuntimeState, SlackConnectionState } from './types.js';

const { version: PRODUCT_VERSION } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

export type RuntimeStarter = (settings: Settings) => Promise<BotRuntime>;

export type StartSkydOptions = {
  homeDir?: string;
  productVersion?: string;
  startRuntime?: RuntimeStarter;
  backoff?: BackoffOptions;
  random?: () => number;
  logger?: JsonlLoggerOptions;
};

export type Skyd = {
  paths: SkydPaths;
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
  const paths = prepareSkydPaths(options.homeDir);
  const logger = createJsonlLogger(paths.logFile, options.logger);
  const instanceId = randomUUID();
  const startedAt = new Date();
  const abortController = new AbortController();
  const mutable: MutableStatus = {
    runtimeState: 'starting',
    slackState: 'not_configured',
    slackAttempts: 0,
    nextRetryAt: null,
    backend: null,
    model: null,
    recentErrors: [],
  };
  let runtime: BotRuntime | undefined;

  const addError = (code: string) => {
    mutable.recentErrors = [...mutable.recentErrors, { code, at: new Date().toISOString() }].slice(-10);
  };

  const status = (): DaemonStatus => ({
    instanceId,
    process: {
      pid: process.pid,
      state: mutable.runtimeState === 'draining' ? 'stopping' : 'running',
      startedAt: startedAt.toISOString(),
      uptimeMs: Math.max(0, Date.now() - startedAt.getTime()),
    },
    runtime: { state: mutable.runtimeState },
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
    activeWorkCount: runtime?.activeWorkCount() ?? 0,
    recentErrors: [...mutable.recentErrors],
  });

  let controlServer: ControlServer;
  try {
    controlServer = await startControlServer(paths.socketFile, status);
  } catch (error) {
    logger.log('error', 'control', error instanceof Error ? error.message : String(error));
    throw error;
  }
  logger.log('info', 'daemon', 'Control interface started.');

  const startRuntime = options.startRuntime ?? startBotRuntime;
  const runtimeTask = (async () => {
    let settings: Settings;
    try {
      settings = loadSecureSettings(paths.settingsFile);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      mutable.runtimeState = 'needs_configuration';
      mutable.slackState = 'not_configured';
      addError(error.code);
      logger.log('warn', 'settings', error.message);
      await waitForAbort(abortController.signal);
      return;
    }

    mutable.backend = settings.agentBackend;
    mutable.model = settings.model;
    logger.protect([
      settings.slack.botToken,
      settings.slack.appToken,
      settings.claudeAgentSdk?.oauthToken ?? '',
    ]);

    let attempt = 0;
    while (!abortController.signal.aborted) {
      mutable.runtimeState = attempt === 0 ? 'starting' : 'degraded';
      mutable.slackState = attempt === 0 ? 'connecting' : 'retrying';
      mutable.nextRetryAt = null;

      try {
        runtime = await startRuntime(settings);
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
          await sleep(delayMs, abortController.signal);
        } catch (sleepError) {
          if (!isAbortError(sleepError)) throw sleepError;
        }
        continue;
      }

      mutable.runtimeState = 'ready';
      mutable.slackState = 'connected';
      mutable.nextRetryAt = null;
      logger.log('info', 'runtime', 'Slack and agent runtime started.');
      try {
        await waitForAbort(abortController.signal);
      } finally {
        await runtime.close();
        runtime = undefined;
      }
      return;
    }
  })().catch((error) => {
    addError('internal_error');
    logger.log('error', 'daemon', error instanceof Error ? error.message : String(error));
    throw error;
  });

  let closePromise: Promise<void> | undefined;
  return {
    paths,
    status,
    finished: runtimeTask,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        mutable.runtimeState = 'draining';
        mutable.slackState = 'stopped';
        mutable.nextRetryAt = null;
        abortController.abort();
        await runtimeTask.catch(() => undefined);
        await controlServer.close();
        logger.log('info', 'daemon', 'Daemon stopped.');
      })();
      return closePromise;
    },
  };
}
