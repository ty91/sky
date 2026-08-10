import { randomUUID } from 'node:crypto';
import os from 'node:os';
import {
  SlackStartupError,
  startBotRuntime,
  type BotRuntime,
  type BotRuntimeObservability,
} from '../bot.js';
import { createConfiguration, type ConfigurationInspection } from '../configuration.js';
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
import { ControlError, createDaemonControl, type DaemonControl } from './control.js';
import { startControlServer, type ControlServer } from './control-uds.js';
import { createAdminAuthentication } from './admin-auth.js';
import {
  DEFAULT_ADMIN_HOST,
  DEFAULT_ADMIN_PORT,
  startAdminHttpServer,
  type AdminAssetReader,
  type AdminHttpServer,
} from './admin-http.js';
import { createJsonlLogger, type JsonlLoggerOptions } from './logger.js';
import { createMaintenanceOperationRunner } from './maintenance.js';
import {
  createOperationRegistry,
  type OperationRegistry,
  type OperationRegistryOptions,
  type OperationRunner,
} from './operations.js';
import { ConfigurationError } from '../configuration.js';
import type {
  AdminGatewayStatus,
  DaemonStatus,
  RuntimeState,
  SlackConnectionState,
} from './types.js';
import { runDiagnostics } from '../diagnostics.js';
import { openScheduledJobStore } from '../scheduler/store.js';
import type { ScheduledJobStore } from '../scheduler/types.js';
import { inspectWorkspacePrompts } from '../workspace-prompts.js';
import {
  connectionTargetForSecret,
  createConnections,
  type ConnectionsOptions,
} from '../connections.js';
import { inspectLaunchAgent, type LaunchdStatus } from '../service/launch-agent.js';
import { createSkydClaudeDiagnostics } from './claude-diagnostics.js';
import { PRODUCT_VERSION } from '../product-version.js';
import { RUNTIME_KIND } from '../runtime-identity.js';

export type RuntimeStarter = (
  settings: Settings,
  runtimeController: RuntimeController,
  skyHome: SkyHome,
  scheduledJobStore: ScheduledJobStore,
  observability?: BotRuntimeObservability,
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
  operationRegistry?: Omit<OperationRegistryOptions, 'runtimeController' | 'logger' | 'run'>;
  admin?:
    | false
    | {
        host?: string;
        port?: number;
        now?: () => Date;
        assets?: AdminAssetReader;
      };
  connections?: Omit<ConnectionsOptions, 'homeDir'>;
  configurationEnv?: NodeJS.ProcessEnv;
  inspectLaunchAgent?: () => LaunchdStatus | Promise<LaunchdStatus>;
};

export type Skyd = {
  paths: SkyHome;
  control: DaemonControl;
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
  admin: AdminGatewayStatus;
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
  const claudeDiagnostics = createSkydClaudeDiagnostics({
    paths,
    logger,
    supervisionMode: runtimeController.supervisionMode,
  });
  const adminOptions = options.admin === false ? undefined : (options.admin ?? {});
  const adminHost = adminOptions?.host ?? DEFAULT_ADMIN_HOST;
  const adminPort = adminOptions?.port ?? DEFAULT_ADMIN_PORT;
  const mutable: MutableStatus = {
    runtimeState: 'starting',
    slackState: 'not_configured',
    slackAttempts: 0,
    nextRetryAt: null,
    backend: null,
    model: null,
    admin: {
      state: adminOptions ? 'starting' : 'stopped',
      host: adminHost,
      port: adminPort,
      error: null,
    },
    recentErrors: [],
  };
  let activeSettings: Settings | undefined;
  let activeConfigurationRevision: number | null = null;
  let activeConfigurationIdentity: string | undefined;
  let runtime: BotRuntime | undefined;
  const configuration = createConfiguration(paths, { env: options.configurationEnv });
  const connections = createConnections(configuration, {
    homeDir: options.homeDir ?? os.homedir(),
    ...options.connections,
    claudeDiagnostics,
  });
  const scheduledJobStore = openScheduledJobStore(paths);
  const controlConfiguration = (inspection: ConfigurationInspection) => ({
    ...inspection.public,
    activeRevision: activeConfigurationRevision,
    restartRequired:
      activeConfigurationIdentity === undefined
        ? inspection.public.complete
        : inspection.identity !== activeConfigurationIdentity,
  });
  const operations: OperationRegistry = createOperationRegistry({
    runtimeController,
    logger,
    run:
      options.runOperation ??
      createMaintenanceOperationRunner(paths, logger, configuration, { claudeDiagnostics }),
    ...options.operationRegistry,
  });
  const adminAuthentication = createAdminAuthentication({
    now: adminOptions?.now,
    protect: (values) => logger.protect(values),
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
      kind: RUNTIME_KIND,
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
    admin: {
      ...mutable.admin,
      error: mutable.admin.error && { ...mutable.admin.error },
    },
    activeWorkCount: runtimeController.activeCount(),
    recentErrors: [...mutable.recentErrors],
  });

  const control = createDaemonControl({
    getStatus: status,
    getRuntimeAdmin: () =>
      status().runtime.state === 'ready' ? runtime?.admin : undefined,
    getOverview: async () => {
      const diagnostics = await runDiagnostics(paths, {
        daemonStatus: status(),
        activeSettings,
        homeDir: options.homeDir,
      });
      const jobs = scheduledJobStore.list();
      const pending = jobs.filter(({ status: jobStatus }) => jobStatus === 'pending');
      return {
        schemaVersion: 1,
        host: {
          hostname: os.hostname(),
          platform: process.platform,
          architecture: process.arch,
        },
        daemon: status(),
        diagnostics,
        scheduler: {
          total: jobs.length,
          pending: pending.length,
          running: jobs.filter(({ status: jobStatus }) => jobStatus === 'running').length,
          failed: jobs.filter(({ status: jobStatus }) => jobStatus === 'failed').length,
          nextRunAt:
            pending.length === 0
              ? null
              : new Date(Math.min(...pending.map(({ nextRunAt }) => nextRunAt))).toISOString(),
        },
      };
    },
    getSystem: async () => ({
      schemaVersion: 1,
      daemon: status(),
      launchAgent: {
        ...(await (options.inspectLaunchAgent?.() ??
          inspectLaunchAgent({ skyHome: paths, homeDir: options.homeDir }))),
        supported: process.platform === 'darwin',
      },
      capabilities: {
        update: 'unsupported',
        rollback: 'unsupported',
      },
    }),
    issueAdminLogin: () => {
      if (mutable.admin.state !== 'listening') throw new ControlError('admin_unavailable');
      return {
        ...adminAuthentication.issueLoginToken(),
        host: mutable.admin.host,
        port: mutable.admin.port,
      };
    },
    requestRestart: () => {
      const result = runtimeController.requestRestart(() => {
        try {
          configuration.resolveRuntime();
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
        : { ok: false, code: result.code, message: result.message };
    },
    operations,
    logger,
    protectSensitiveValues: (values) => logger.protect(values),
    getDiagnostics: () =>
      runDiagnostics(paths, {
        daemonStatus: status(),
        activeSettings,
        homeDir: options.homeDir,
      }),
    getWorkspacePrompts: () =>
      inspectWorkspacePrompts(configuration.inspect().public.settings.workspace),
    connections,
    configuration: {
      get: () => controlConfiguration(configuration.inspect()),
      patch: (expectedRevision, patch) => {
        const updated = controlConfiguration(configuration.patch(expectedRevision, patch));
        connections.invalidate('agent');
        return updated;
      },
      setSecret: (name, value) => {
        const updated = controlConfiguration(configuration.setSecret(name, value));
        connections.invalidate(connectionTargetForSecret(name));
        return updated;
      },
      deleteSecret: (name) => {
        const updated = controlConfiguration(configuration.deleteSecret(name));
        connections.invalidate(connectionTargetForSecret(name));
        return updated;
      },
    },
  });

  let controlServer: ControlServer;
  try {
    controlServer = await startControlServer(paths.socketFile, control);
  } catch (error) {
    logger.log('error', 'control', error instanceof Error ? error.message : String(error));
    throw error;
  }
  logger.log('info', 'daemon', 'Control interface started.');

  let adminServer: AdminHttpServer | undefined;
  if (adminOptions) {
    try {
      adminServer = await startAdminHttpServer({
        host: adminHost,
        port: adminPort,
        control,
        authentication: adminAuthentication,
        assets: adminOptions.assets,
      });
      mutable.admin = {
        state: 'listening',
        host: adminServer.host,
        port: adminServer.port,
        error: null,
      };
      logger.log(
        'info',
        'admin',
        `Admin gateway started on ${adminServer.host}:${adminServer.port}.`,
      );
    } catch (error) {
      mutable.admin = {
        state: 'failed',
        host: adminHost,
        port: adminPort,
        error: { code: 'admin_bind_failed' },
      };
      addError('admin_bind_failed');
      const reason =
        error instanceof Error && 'code' in error ? String(error.code) : 'unknown_error';
      logger.log(
        'error',
        'admin',
        `admin_bind_failed: Admin gateway could not bind to ${adminHost}:${adminPort} (${reason}).`,
      );
    }
  }

  const startRuntime = options.startRuntime ?? startBotRuntime;
  const runtimeTask = (async () => {
    let settings: Settings;
    try {
      const resolved = configuration.resolveRuntime();
      settings = resolved.settings;
      activeConfigurationRevision = resolved.revision;
      activeConfigurationIdentity = resolved.identity;
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
        runtime = await startRuntime(settings, runtimeController, paths, scheduledJobStore, {
          claudeDiagnostics,
        });
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
    scheduledJobStore.close();
    mutable.slackState = 'stopped';
    if (adminServer) {
      await adminServer.close();
      adminServer = undefined;
      mutable.admin = { ...mutable.admin, state: 'stopped' };
    }
    await controlServer.close();
    runtimeController.finish();
    logger.log('info', 'daemon', 'Daemon stopped.');
    if (runtimeError) throw runtimeError;
  })();

  return {
    paths,
    control,
    status,
    finished: lifecycleTask,
    close() {
      runtimeController.requestStop();
      return lifecycleTask;
    },
  };
}
