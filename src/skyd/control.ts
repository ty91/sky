import {
  ConfigurationError,
  type ConfigurationErrorCode,
  type PublicConfiguration,
  type SecretName,
  type SettingsPatch,
} from '../configuration.js';
import type { DiagnosticsReport } from '../diagnostics.js';
import type {
  ConnectionTarget,
  ConnectionsSnapshot,
} from '../connections.js';
import { LogCursorNotFoundError, type JsonlLogger, type LogHistory, type LogRecord } from './logger.js';
import type {
  OperationEvent,
  OperationRecord,
  OperationRegistry,
  OperationRequest,
} from './operations.js';
import type { AdminOverview, DaemonStatus } from './types.js';
import type { WorkspacePromptSnapshot } from '../workspace-prompts.js';

export type ControlConfiguration = PublicConfiguration & {
  activeRevision: number | null;
  restartRequired: boolean;
};

export type ControlRestartResult =
  | { ok: true; instanceId: string }
  | { ok: false; code: string; message: string };

export type AdminLoginGrant = {
  token: string;
  expiresAt: string;
  host: string;
  port: number;
};

export type ControlDependencies = {
  getStatus(): DaemonStatus;
  getOverview?: () => AdminOverview | Promise<AdminOverview>;
  issueAdminLogin?: () => AdminLoginGrant;
  requestRestart?: () => ControlRestartResult;
  operations?: OperationRegistry;
  logger?: JsonlLogger;
  protectSensitiveValues?: (values: readonly string[]) => void;
  getDiagnostics?: () => DiagnosticsReport | Promise<DiagnosticsReport>;
  getWorkspacePrompts?: () => WorkspacePromptSnapshot | Promise<WorkspacePromptSnapshot>;
  connections?: {
    get(): ConnectionsSnapshot;
    check(target: ConnectionTarget): Promise<ConnectionsSnapshot>;
  };
  configuration?: {
    get(): ControlConfiguration;
    patch(expectedRevision: number, patch: SettingsPatch): ControlConfiguration;
    setSecret(name: SecretName, value: string): ControlConfiguration;
    deleteSecret(name: SecretName): ControlConfiguration;
  };
};

type ConfigurationPatchBody = {
  expectedRevision: number;
  patch: SettingsPatch;
};

type SecretValueBody = {
  value: string;
};

export type ControlExecuteRequest =
  | { type: 'status' }
  | { type: 'overview' }
  | { type: 'admin.login.issue' }
  | { type: 'diagnostics' }
  | { type: 'workspace.prompts.get' }
  | { type: 'connections.get' }
  | { type: 'connections.check'; target: ConnectionTarget }
  | { type: 'configuration.get' }
  | { type: 'configuration.patch'; body: ConfigurationPatchBody }
  | { type: 'secret.put'; name: SecretName; body: SecretValueBody }
  | { type: 'secret.delete'; name: SecretName }
  | { type: 'restart' }
  | { type: 'operation.create'; body: OperationRequest }
  | { type: 'operation.get'; operationId: string }
  | { type: 'logs.history'; cursor?: string; limit?: number };

export type ControlSubscribeRequest =
  | { type: 'operation.events'; operationId: string; after?: number; signal?: AbortSignal }
  | { type: 'logs.stream'; cursor?: string; signal?: AbortSignal };

export type ControlExecuteResult<Request extends ControlExecuteRequest> =
  Request extends { type: 'status' }
    ? DaemonStatus
    : Request extends { type: 'overview' }
      ? AdminOverview
      : Request extends { type: 'admin.login.issue' }
        ? AdminLoginGrant
        : Request extends { type: 'diagnostics' }
          ? DiagnosticsReport
          : Request extends { type: 'workspace.prompts.get' }
            ? WorkspacePromptSnapshot
          : Request extends { type: 'connections.get' } | { type: 'connections.check' }
            ? ConnectionsSnapshot
          : Request extends
              | { type: 'configuration.get' }
              | { type: 'configuration.patch' }
              | { type: 'secret.put' }
              | { type: 'secret.delete' }
          ? ControlConfiguration
          : Request extends { type: 'restart' }
            ? { accepted: true; instanceId: string }
            : Request extends { type: 'operation.create' }
              ? { operationId: string }
              : Request extends { type: 'operation.get' }
                ? OperationRecord
                : Request extends { type: 'logs.history' }
                  ? LogHistory
                  : never;

export type ControlSubscribeResult<Request extends ControlSubscribeRequest> =
  Request extends { type: 'operation.events' } ? AsyncIterable<OperationEvent> : AsyncIterable<LogRecord>;

export type DaemonControl = {
  execute<Request extends ControlExecuteRequest>(
    request: Request,
  ): Promise<ControlExecuteResult<Request>>;
  subscribe<Request extends ControlSubscribeRequest>(
    request: Request,
  ): ControlSubscribeResult<Request>;
};

type ErrorContext = 'default' | 'restart';

// This is the single code-to-HTTP mapping shared by every control adapter.
function errorStatus(code: string, context: ErrorContext): number {
  if (context === 'restart') return 409;
  switch (code) {
    case 'not_found':
    case 'unknown_secret':
    case 'operation_not_found':
      return 404;
    case 'method_not_allowed':
      return 405;
    case 'log_cursor_expired':
      return 410;
    case 'revision_conflict':
    case 'settings_unsafe':
    case 'secrets_unsafe':
    case 'migration_conflict':
    case 'configuration_draining':
    case 'operation_active':
      return 409;
    case 'configuration_incomplete':
    case 'secret_missing':
      return 422;
    case 'daemon_draining':
    case 'admin_unavailable':
      return 503;
    case 'internal_error':
      return 500;
    default:
      return 400;
  }
}

export class ControlError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
    context: ErrorContext = 'default',
  ) {
    super(`Control request failed with ${code}.`);
    this.name = 'ControlError';
    this.statusCode = errorStatus(code, context);
  }
}

function asResult<Request extends ControlExecuteRequest>(
  value: unknown,
): ControlExecuteResult<Request> {
  return value as ControlExecuteResult<Request>;
}

function asSubscription<Request extends ControlSubscribeRequest>(
  value: AsyncIterable<OperationEvent> | AsyncIterable<LogRecord>,
): ControlSubscribeResult<Request> {
  return value as ControlSubscribeResult<Request>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidConfigurationRequest(code: ConfigurationErrorCode = 'invalid_value'): never {
  throw new ConfigurationError(code, 'The request is invalid.');
}

function parseConfigurationPatch(value: unknown): ConfigurationPatchBody {
  if (!isRecord(value)) invalidConfigurationRequest();
  if (
    Object.keys(value).some((key) => key !== 'expectedRevision' && key !== 'patch') ||
    !isRecord(value.patch)
  ) {
    invalidConfigurationRequest();
  }
  return {
    expectedRevision: value.expectedRevision as number,
    patch: value.patch as SettingsPatch,
  };
}

function parseSecretValue(value: unknown): SecretValueBody {
  if (!isRecord(value)) invalidConfigurationRequest();
  if (Object.keys(value).some((key) => key !== 'value')) {
    invalidConfigurationRequest('unknown_field');
  }
  return { value: value.value as string };
}

function parseOperationRequest(value: unknown): OperationRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'memory' && Object.keys(value).length === 1) return { type: 'memory' };
  if (value.type !== 'dream') return undefined;
  if (
    value.date !== undefined &&
    (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date))
  ) {
    return undefined;
  }
  if (value.step !== undefined && value.step !== 'summarize' && value.step !== 'knowledge') {
    return undefined;
  }
  if (Object.keys(value).some((key) => key !== 'type' && key !== 'date' && key !== 'step')) {
    return undefined;
  }
  return {
    type: 'dream',
    ...(typeof value.date === 'string' ? { date: value.date } : {}),
    ...(value.step === 'summarize' || value.step === 'knowledge' ? { step: value.step } : {}),
  };
}

function terminalOperation(state: OperationRecord['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

function translateError(error: unknown): ControlError {
  if (error instanceof ControlError) return error;
  if (error instanceof ConfigurationError) return new ControlError(error.code, error.details);
  if (error instanceof LogCursorNotFoundError) return new ControlError('log_cursor_expired');
  return new ControlError('internal_error');
}

function translateConfigurationError(error: unknown): ControlError {
  if (error instanceof ControlError) return error;
  if (error instanceof ConfigurationError) return new ControlError(error.code, error.details);
  return new ControlError('invalid_request');
}

function bufferedStream<T>(
  initial: readonly T[],
  subscribe: ((listener: (value: T) => void) => () => void) | undefined,
  terminal: (value: T) => boolean,
  signal?: AbortSignal,
  initiallyEnded = false,
): AsyncIterable<T> {
  let queue = [...initial];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let ended = initiallyEnded || initial.some(terminal);
  let consumed = false;
  let unsubscribe: (() => void) | undefined;

  const removeAbortListener = () => signal?.removeEventListener('abort', abort);
  const finish = (discardQueued = false) => {
    if (ended && !discardQueued) return;
    ended = true;
    unsubscribe?.();
    unsubscribe = undefined;
    removeAbortListener();
    if (discardQueued) queue = [];
    while (waiters.length > 0) {
      waiters.shift()?.({ value: undefined as T, done: true });
    }
  };
  const abort = () => finish(true);
  const push = (value: T) => {
    if (ended) return;
    const waiter = waiters.shift();
    if (waiter) waiter({ value, done: false });
    else queue.push(value);
    if (terminal(value)) finish();
  };

  if (!ended && subscribe) unsubscribe = subscribe(push);
  if (signal?.aborted) abort();
  else if (!ended) signal?.addEventListener('abort', abort, { once: true });

  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      if (consumed) throw new Error('A control subscription can only be consumed once.');
      consumed = true;
      return {
        next(): Promise<IteratorResult<T>> {
          const value = queue.shift();
          if (value !== undefined) return Promise.resolve({ value, done: false });
          if (ended) return Promise.resolve({ value: undefined as T, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<T>> {
          finish(true);
          return Promise.resolve({ value: undefined as T, done: true });
        },
      };
    },
  };
}

export function createDaemonControl(dependencies: ControlDependencies): DaemonControl {
  return {
    async execute<Request extends ControlExecuteRequest>(
      request: Request,
    ): Promise<ControlExecuteResult<Request>> {
      try {
        if (
          request.type === 'secret.put' &&
          isRecord(request.body) &&
          typeof request.body.value === 'string'
        ) {
          dependencies.protectSensitiveValues?.([request.body.value]);
        }
        switch (request.type) {
          case 'status':
            return asResult<Request>(dependencies.getStatus());
          case 'overview':
            if (!dependencies.getOverview) throw new ControlError('not_found');
            return asResult<Request>(await dependencies.getOverview());
          case 'admin.login.issue':
            if (!dependencies.issueAdminLogin) throw new ControlError('admin_unavailable');
            return asResult<Request>(dependencies.issueAdminLogin());
          case 'diagnostics':
            if (!dependencies.getDiagnostics) throw new ControlError('not_found');
            return asResult<Request>(await dependencies.getDiagnostics());
          case 'workspace.prompts.get':
            if (!dependencies.getWorkspacePrompts) throw new ControlError('not_found');
            return asResult<Request>(await dependencies.getWorkspacePrompts());
          case 'connections.get':
            if (!dependencies.connections) throw new ControlError('not_found');
            return asResult<Request>(dependencies.connections.get());
          case 'connections.check':
            if (!dependencies.connections) throw new ControlError('not_found');
            if (
              request.target !== 'slack.bot' &&
              request.target !== 'slack.app' &&
              request.target !== 'agent'
            ) {
              throw new ControlError('invalid_value');
            }
            return asResult<Request>(await dependencies.connections.check(request.target));
          case 'configuration.get':
            if (!dependencies.configuration) throw new ControlError('not_found');
            return asResult<Request>(dependencies.configuration.get());
          case 'configuration.patch': {
            if (!dependencies.configuration) throw new ControlError('not_found');
            if (dependencies.getStatus().runtime.state === 'draining') {
              throw new ControlError('configuration_draining');
            }
            const body = parseConfigurationPatch(request.body);
            try {
              return asResult<Request>(
                dependencies.configuration.patch(body.expectedRevision, body.patch),
              );
            } catch (error) {
              if (error instanceof ConfigurationError && error.code === 'revision_conflict') {
                throw new ControlError('revision_conflict', {
                  current: dependencies.configuration.get(),
                });
              }
              throw error;
            }
          }
          case 'secret.put': {
            if (!dependencies.configuration) throw new ControlError('not_found');
            if (dependencies.getStatus().runtime.state === 'draining') {
              throw new ControlError('configuration_draining');
            }
            const body = parseSecretValue(request.body);
            return asResult<Request>(
              dependencies.configuration.setSecret(request.name, body.value),
            );
          }
          case 'secret.delete':
            if (!dependencies.configuration) throw new ControlError('not_found');
            if (dependencies.getStatus().runtime.state === 'draining') {
              throw new ControlError('configuration_draining');
            }
            return asResult<Request>(
              dependencies.configuration.deleteSecret(request.name),
            );
          case 'restart': {
            if (!dependencies.requestRestart) throw new ControlError('not_found');
            const result = dependencies.requestRestart();
            if (!result.ok) {
              throw new ControlError(result.code, { message: result.message }, 'restart');
            }
            return asResult<Request>({ accepted: true, instanceId: result.instanceId });
          }
          case 'operation.create': {
            if (!dependencies.operations) throw new ControlError('not_found');
            const input = parseOperationRequest(request.body);
            if (!input) throw new ControlError('invalid_operation');
            const result = dependencies.operations.create(input);
            if (!result.ok) {
              throw new ControlError(
                result.code,
                result.code === 'operation_active'
                  ? { activeOperationId: result.activeOperationId }
                  : {},
              );
            }
            return asResult<Request>({ operationId: result.operation.id });
          }
          case 'operation.get': {
            if (!dependencies.operations) throw new ControlError('not_found');
            const operation = dependencies.operations.get(request.operationId);
            if (!operation) throw new ControlError('operation_not_found');
            return asResult<Request>(operation);
          }
          case 'logs.history': {
            if (!dependencies.logger) throw new ControlError('not_found');
            const limit = request.limit ?? 200;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
              throw new ControlError('invalid_limit');
            }
            return asResult<Request>(dependencies.logger.history(request.cursor, limit));
          }
        }
      } catch (error) {
        if (
          request.type === 'configuration.get' ||
          request.type === 'configuration.patch' ||
          request.type === 'secret.put' ||
          request.type === 'secret.delete'
        ) {
          throw translateConfigurationError(error);
        }
        throw translateError(error);
      }
    },

    subscribe<Request extends ControlSubscribeRequest>(
      request: Request,
    ): ControlSubscribeResult<Request> {
      try {
        if (request.type === 'operation.events') {
          if (!dependencies.operations) throw new ControlError('not_found');
          const after = request.after ?? 0;
          if (!Number.isSafeInteger(after) || after < 0) {
            throw new ControlError('invalid_cursor');
          }
          const source = dependencies.operations.events(request.operationId, after);
          if (!source) throw new ControlError('operation_not_found');
          return asSubscription<Request>(
            bufferedStream(
              source.events,
              source.subscribe,
              (event) => terminalOperation(event.type as OperationRecord['state']),
              request.signal,
              terminalOperation(source.operation.state),
            ),
          );
        }

        if (!dependencies.logger) throw new ControlError('not_found');
        const history = dependencies.logger.history(request.cursor, 1_000);
        return asSubscription<Request>(
          bufferedStream(history.records, dependencies.logger.subscribe, () => false, request.signal),
        );
      } catch (error) {
        throw translateError(error);
      }
    },
  };
}
