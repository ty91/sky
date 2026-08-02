import { randomUUID } from 'node:crypto';
import type { RuntimeController } from '../runtime/controller.js';
import type { JsonlLogger } from './logger.js';

export type OperationKind = 'memory' | 'dream';
export type OperationState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type OperationRequest =
  | { type: 'memory' }
  | { type: 'dream'; date?: string; step?: 'summarize' | 'knowledge' };

export type OperationError = {
  code: 'operation_failed';
};

export type OperationRecord = {
  id: string;
  type: OperationKind;
  input: OperationRequest;
  state: OperationState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: unknown | null;
  error: OperationError | null;
};

export type OperationEvent = {
  operationId: string;
  sequence: number;
  timestamp: string;
  type: OperationState | 'progress';
  message?: string;
};

export type OperationRunnerContext = {
  signal: AbortSignal;
  progress(message: string): void;
};

export type OperationRunner = (
  request: OperationRequest,
  context: OperationRunnerContext,
) => Promise<unknown>;

type StoredOperation = OperationRecord & {
  events: OperationEvent[];
  nextEventSequence: number;
  listeners: Set<(event: OperationEvent) => void>;
  abortController: AbortController;
};

export type CreateOperationResult =
  | { ok: true; operation: OperationRecord }
  | { ok: false; code: 'operation_active'; activeOperationId: string }
  | { ok: false; code: 'daemon_draining' };

export type OperationRegistry = {
  create(request: OperationRequest): CreateOperationResult;
  get(id: string): OperationRecord | undefined;
  events(
    id: string,
    afterSequence?: number,
  ):
    | {
        operation: OperationRecord;
        events: OperationEvent[];
        subscribe(listener: (event: OperationEvent) => void): () => void;
      }
    | undefined;
  cancelActive(): void;
};

export type OperationRegistryOptions = {
  runtimeController: RuntimeController;
  logger: JsonlLogger;
  run: OperationRunner;
  now?: () => Date;
  createId?: () => string;
  completedLimit?: number;
  retentionMs?: number;
  eventLimit?: number;
};

const DEFAULT_COMPLETED_LIMIT = 100;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_EVENT_LIMIT = 1_000;

function publicRecord(operation: StoredOperation): OperationRecord {
  return {
    id: operation.id,
    type: operation.type,
    input: operation.input,
    state: operation.state,
    createdAt: operation.createdAt,
    startedAt: operation.startedAt,
    finishedAt: operation.finishedAt,
    result: operation.result,
    error: operation.error,
  };
}

export function createOperationRegistry(options: OperationRegistryOptions): OperationRegistry {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const completedLimit = options.completedLimit ?? DEFAULT_COMPLETED_LIMIT;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const eventLimit = options.eventLimit ?? DEFAULT_EVENT_LIMIT;
  const operations = new Map<string, StoredOperation>();
  let activeOperationId: string | undefined;

  const emit = (operation: StoredOperation, type: OperationEvent['type'], message?: string) => {
    const event: OperationEvent = {
      operationId: operation.id,
      sequence: operation.nextEventSequence,
      timestamp: now().toISOString(),
      type,
      ...(message ? { message } : {}),
    };
    operation.nextEventSequence += 1;
    operation.events.push(event);
    if (operation.events.length > eventLimit) {
      operation.events.splice(0, operation.events.length - eventLimit);
    }
    for (const listener of operation.listeners) listener(event);
  };

  const prune = () => {
    const cutoff = now().getTime() - retentionMs;
    const completed: StoredOperation[] = [];
    for (const operation of operations.values()) {
      if (operation.finishedAt === null) continue;
      const finishedAt = Date.parse(operation.finishedAt);
      const index = completed.findIndex(
        (candidate) => Date.parse(candidate.finishedAt!) < finishedAt,
      );
      completed.splice(index === -1 ? completed.length : index, 0, operation);
    }
    for (const [index, operation] of completed.entries()) {
      if (index >= completedLimit || Date.parse(operation.finishedAt!) < cutoff) {
        operations.delete(operation.id);
      }
    }
  };

  const registry: OperationRegistry = {
    create(request) {
      prune();
      if (!options.runtimeController.isAccepting()) {
        return { ok: false, code: 'daemon_draining' };
      }
      if (activeOperationId) {
        return { ok: false, code: 'operation_active', activeOperationId };
      }

      const lease = options.runtimeController.lease('maintenance');
      if (!lease) return { ok: false, code: 'daemon_draining' };

      const operation: StoredOperation = {
        id: createId(),
        type: request.type,
        input: request,
        state: 'queued',
        createdAt: now().toISOString(),
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
        events: [],
        nextEventSequence: 1,
        listeners: new Set(),
        abortController: new AbortController(),
      };
      operations.set(operation.id, operation);
      activeOperationId = operation.id;
      emit(operation, 'queued');

      queueMicrotask(() => {
        void (async () => {
          operation.state = 'running';
          operation.startedAt = now().toISOString();
          emit(operation, 'running');
          options.logger.log('info', 'operation', `${operation.type} operation started.`, {
            operationId: operation.id,
          });
          try {
            const result = await options.run(request, {
              signal: operation.abortController.signal,
              progress: (message) => emit(operation, 'progress', message),
            });
            if (operation.abortController.signal.aborted) {
              operation.state = 'cancelled';
              emit(operation, 'cancelled');
              options.logger.log('warn', 'operation', `${operation.type} operation cancelled.`, {
                operationId: operation.id,
              });
            } else {
              operation.state = 'succeeded';
              operation.result = result;
              emit(operation, 'succeeded');
              options.logger.log('info', 'operation', `${operation.type} operation succeeded.`, {
                operationId: operation.id,
              });
            }
          } catch (error) {
            if (operation.abortController.signal.aborted) {
              operation.state = 'cancelled';
              emit(operation, 'cancelled');
              options.logger.log('warn', 'operation', `${operation.type} operation cancelled.`, {
                operationId: operation.id,
              });
            } else {
              operation.state = 'failed';
              operation.error = { code: 'operation_failed' };
              emit(operation, 'failed');
              options.logger.log(
                'error',
                'operation',
                `${operation.type} operation failed (${error instanceof Error ? error.name : 'unknown_error'}).`,
                { operationId: operation.id },
              );
            }
          } finally {
            operation.finishedAt = now().toISOString();
            if (activeOperationId === operation.id) activeOperationId = undefined;
            lease.release();
            prune();
          }
        })();
      });

      return { ok: true, operation: publicRecord(operation) };
    },

    get(id) {
      prune();
      const operation = operations.get(id);
      return operation ? publicRecord(operation) : undefined;
    },

    events(id, afterSequence = 0) {
      prune();
      const operation = operations.get(id);
      if (!operation) return undefined;
      return {
        operation: publicRecord(operation),
        events: operation.events.filter((event) => event.sequence > afterSequence),
        subscribe(listener) {
          operation.listeners.add(listener);
          return () => operation.listeners.delete(listener);
        },
      };
    },

    cancelActive() {
      if (!activeOperationId) return;
      operations.get(activeOperationId)?.abortController.abort('daemon_shutdown');
    },
  };

  return registry;
}
