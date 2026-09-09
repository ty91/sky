export type SupervisionMode = 'launchd' | 'foreground';

export type RuntimeActivityKind = 'slack_turn' | 'scheduler_dispatch' | 'maintenance';

export type RuntimeActivityLease = {
  release(): void;
};

export type RestartRejection = {
  code: string;
  message: string;
};

export type RestartRequestResult =
  | { ok: true }
  | ({ ok: false } & RestartRejection);

type ShutdownRequest = {
  reason: 'restart' | 'stop';
  timeoutMs: number;
};

export type RuntimeController = {
  readonly supervisionMode: SupervisionMode;
  readonly drainingSignal: AbortSignal;
  isAccepting(): boolean;
  activeCount(): number;
  lease(kind: RuntimeActivityKind): RuntimeActivityLease | undefined;
  requestRestart(prepare?: () => RestartRejection | undefined): RestartRequestResult;
  requestStop(): void;
  drain(): Promise<{ timedOut: boolean }>;
  finish(): void;
};

export type RuntimeControllerOptions = {
  supervisionMode: SupervisionMode;
  restartTimeoutMs?: number;
  stopTimeoutMs?: number;
};

const DEFAULT_RESTART_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_TIMEOUT_MS = 20_000;

export function createRuntimeController(options: RuntimeControllerOptions): RuntimeController {
  const restartTimeoutMs = options.restartTimeoutMs ?? DEFAULT_RESTART_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const drainingController = new AbortController();
  let state: 'accepting' | 'draining' | 'finished' = 'accepting';
  let activeCount = 0;
  let shutdownRequest: ShutdownRequest | undefined;
  let resolveShutdown!: (request: ShutdownRequest) => void;
  const shutdownRequested = new Promise<ShutdownRequest>((resolve) => {
    resolveShutdown = resolve;
  });
  const idleWaiters = new Set<() => void>();

  const beginShutdown = (request: ShutdownRequest) => {
    if (state !== 'accepting') return;
    state = 'draining';
    shutdownRequest = request;
    drainingController.abort(request.reason);
    resolveShutdown(request);
  };

  const controller: RuntimeController = {
    supervisionMode: options.supervisionMode,
    drainingSignal: drainingController.signal,

    isAccepting() {
      return state === 'accepting';
    },

    activeCount() {
      return activeCount;
    },

    lease(_kind) {
      if (state !== 'accepting') return undefined;
      activeCount += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          activeCount -= 1;
          if (activeCount === 0) {
            for (const resolve of idleWaiters) resolve();
            idleWaiters.clear();
          }
        },
      };
    },

    requestRestart(prepare) {
      if (options.supervisionMode === 'foreground') {
        return {
          ok: false,
          code: 'restart_unsupported_foreground',
          message: 'Restart is unavailable in foreground mode because no supervisor can replace skyd.',
        };
      }
      if (state !== 'accepting') {
        return {
          ok: false,
          code: 'restart_in_progress',
          message: 'The daemon is already draining.',
        };
      }
      const rejection = prepare?.();
      if (rejection) return { ok: false, ...rejection };
      beginShutdown({ reason: 'restart', timeoutMs: restartTimeoutMs });
      return { ok: true };
    },

    requestStop() {
      beginShutdown({ reason: 'stop', timeoutMs: stopTimeoutMs });
    },

    async drain() {
      const request = shutdownRequest ?? (await shutdownRequested);
      if (activeCount === 0) return { timedOut: false };

      let timeout: NodeJS.Timeout | undefined;
      const idle = new Promise<'idle'>((resolve) => {
        idleWaiters.add(() => resolve('idle'));
      });
      const expired = new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), request.timeoutMs);
      });
      const result = await Promise.race([idle, expired]);
      if (timeout) clearTimeout(timeout);
      if (result === 'timeout') {
        return { timedOut: true };
      }
      return { timedOut: false };
    },

    finish() {
      state = 'finished';
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    },
  };

  return controller;
}
