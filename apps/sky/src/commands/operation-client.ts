import {
  ControlRequestError,
  createOperation,
  getOperation,
  watchOperation,
} from '../skyd/control-uds.js';
import type { OperationEvent, OperationRecord, OperationRequest } from '../skyd/operations.js';
import { createSkyHome } from '../sky-home.js';

function operationErrorMessage(error: unknown): string {
  if (error instanceof ControlRequestError) {
    switch (error.code) {
      case 'operation_active':
        return `Another maintenance operation is active: ${String(error.details.activeOperationId ?? 'unknown')}`;
      case 'daemon_draining':
        return 'The daemon is draining and cannot accept a new operation.';
      case 'operation_not_found':
        return 'The operation was not found. It may have expired or belonged to a previous daemon instance.';
      case 'invalid_operation':
        return 'The operation request is invalid.';
      default:
        return `The daemon rejected the request (${error.code}).`;
    }
  }
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  if (code === 'ENOENT' || code === 'ECONNREFUSED') {
    return 'The daemon is not running or its control socket is unavailable.';
  }
  return error instanceof Error ? error.message : String(error);
}

function printEvent(event: OperationEvent, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(event));
    return;
  }
  if (event.type === 'progress' && event.message) {
    console.log(event.message);
  } else if (event.type === 'running') {
    console.log('Operation started.');
  } else if (event.type === 'succeeded') {
    console.log('Operation succeeded.');
  } else if (event.type === 'failed') {
    console.log('Operation failed.');
  } else if (event.type === 'cancelled') {
    console.log('Operation was cancelled during daemon shutdown.');
  }
}

export function printOperation(operation: OperationRecord, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(operation, null, 2));
    return;
  }
  console.log(`operation: ${operation.id}`);
  console.log(`type: ${operation.type}`);
  console.log(`state: ${operation.state}`);
  console.log(`created: ${operation.createdAt}`);
  if (operation.startedAt) console.log(`started: ${operation.startedAt}`);
  if (operation.finishedAt) console.log(`finished: ${operation.finishedAt}`);
  if (operation.result !== null) console.log(`result: ${JSON.stringify(operation.result)}`);
  if (operation.error) console.log(`error: ${operation.error.code}`);
}

function setExitCode(operation: OperationRecord): void {
  if (operation.state === 'failed' || operation.state === 'cancelled') process.exitCode = 1;
}

export async function watchOperationFromCli(
  operationId: string,
  options: { json?: boolean } = {},
): Promise<void> {
  const socketFile = createSkyHome().socketFile;
  const abortController = new AbortController();
  let detached = false;
  const detach = () => {
    detached = true;
    abortController.abort();
  };
  process.once('SIGINT', detach);
  try {
    for await (const event of watchOperation(socketFile, operationId, {
      signal: abortController.signal,
    })) {
      printEvent(event, options.json === true);
    }
    if (detached) {
      if (!options.json) console.error(`Detached from operation ${operationId}.`);
      return;
    }
    const operation = await getOperation(socketFile, operationId);
    if (!options.json) printOperation(operation, false);
    setExitCode(operation);
  } catch (error) {
    if (detached || abortController.signal.aborted) return;
    console.error(`error: ${operationErrorMessage(error)}`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', detach);
  }
}

export async function createOperationFromCli(
  request: OperationRequest,
  options: { detach?: boolean } = {},
): Promise<void> {
  const socketFile = createSkyHome().socketFile;
  try {
    const { operationId } = await createOperation(socketFile, request);
    const watching = options.detach ? undefined : watchOperationFromCli(operationId);
    console.log(`operation: ${operationId}`);
    await watching;
  } catch (error) {
    console.error(`error: ${operationErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

export async function showOperationStatus(operationId: string, json: boolean): Promise<void> {
  try {
    const operation = await getOperation(createSkyHome().socketFile, operationId);
    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: operation.state !== 'failed' && operation.state !== 'cancelled',
            operation,
          },
          null,
          2,
        ),
      );
    } else {
      printOperation(operation, false);
    }
    setExitCode(operation);
  } catch (error) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: {
              code: error instanceof ControlRequestError ? error.code : 'daemon_unavailable',
            },
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`error: ${operationErrorMessage(error)}`);
    }
    process.exitCode = 1;
  }
}
