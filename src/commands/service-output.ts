import type { InstallResult, ServiceStatus } from '../service/launch-agent.js';
import { ServiceLifecycleError } from '../service/launch-agent.js';

export function runtimeState(status: ServiceStatus): string {
  return status.control.status?.runtime.state ?? 'unreachable';
}

export function isReady(status: ServiceStatus): boolean {
  return runtimeState(status) === 'ready';
}

export function printStatus(status: ServiceStatus): void {
  if (!status.launchd.installed) {
    console.log('LaunchAgent: not installed');
  } else if (!status.launchd.loaded) {
    console.log('LaunchAgent: installed, not loaded');
  } else {
    const pid = status.launchd.pid === null ? '' : ` (pid: ${status.launchd.pid})`;
    console.log(`LaunchAgent: ${status.launchd.state ?? 'loaded'}${pid}`);
  }

  const daemon = status.control.status;
  if (!daemon) {
    console.log('daemon: unreachable');
    return;
  }

  console.log(`daemon: ${daemon.runtime.state}`);
  console.log(`supervision: ${daemon.supervision?.mode ?? 'unknown'}`);
  console.log(`Slack: ${daemon.slack.state}`);
  console.log(`version: ${daemon.productVersion}`);
  if (daemon.agent.backend) console.log(`agent backend: ${daemon.agent.backend}`);
  if (daemon.agent.model) console.log(`model: ${daemon.agent.model}`);
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function reportStatusResult(status: ServiceStatus, json: boolean): void {
  const ready = isReady(status);
  if (json) {
    printJson({ ok: ready, status });
  } else {
    printStatus(status);
  }
  if (!ready) process.exitCode = 1;
}

export function reportInstallResult(result: InstallResult, json: boolean): void {
  const ready = isReady(result.status);
  if (json) {
    printJson({ ok: ready, ...result });
  } else {
    console.log(result.changed ? 'LaunchAgent installed.' : 'LaunchAgent is already up to date.');
    if (result.legacyMigration === 'terminated') {
      console.log('Migrated the legacy Sky daemon.');
    } else if (result.legacyMigration === 'unrelated_process_ignored') {
      console.error('Ignored a reused legacy PID that belongs to another process.');
    }
    printStatus(result.status);
  }
  if (!ready) process.exitCode = 1;
}

export function reportLifecycleError(error: unknown, json: boolean): void {
  const lifecycleError =
    error instanceof ServiceLifecycleError
      ? error
      : new ServiceLifecycleError(
          'unexpected_error',
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );

  if (json) {
    printJson({
      ok: false,
      error: {
        code: lifecycleError.code,
        message: lifecycleError.message,
      },
      rollback: lifecycleError.rollback,
      status: lifecycleError.status,
    });
  } else {
    console.error(`error: ${lifecycleError.message}`);
    if (lifecycleError.rollback.attempted) {
      console.error(
        lifecycleError.rollback.succeeded
          ? 'rollback: previous LaunchAgent restored'
          : `rollback: failed (${lifecycleError.rollback.message ?? 'unknown error'})`,
      );
    }
    if (lifecycleError.status) printStatus(lifecycleError.status);
  }
  process.exitCode = 1;
}
