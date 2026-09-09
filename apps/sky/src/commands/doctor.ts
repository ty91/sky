import { Command } from 'commander';
import { runDiagnostics, withDaemonVersionDrift, type DiagnosticsReport } from '../diagnostics.js';
import { createSkyHome } from '../sky-home.js';
import {
  ControlRequestError,
  getDaemonDiagnostics,
  getDaemonStatus,
} from '../skyd/control-uds.js';

function controlUnavailable(error: unknown): boolean {
  if (error instanceof ControlRequestError || error instanceof SyntaxError) return false;
  if (!(error instanceof Error) || !('code' in error)) return false;
  return ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTSOCK'].includes(
    String(error.code),
  );
}

async function daemonProductVersion(socketFile: string): Promise<string | null> {
  try {
    return (await getDaemonStatus(socketFile)).productVersion;
  } catch {
    return null;
  }
}

function printHuman(report: DiagnosticsReport): void {
  console.log(`Sky doctor (${report.mode}): ${report.overall.toUpperCase()}`);
  for (const result of report.checks) {
    console.log(`${result.status.toUpperCase()} ${result.id}: ${result.summary}`);
    if (result.detail) console.log(`  ${result.detail}`);
    if (result.remediation && result.status !== 'pass') {
      console.log(`  Fix: ${result.remediation}`);
    }
  }
}

export const doctorCommand = new Command('doctor')
  .description('Diagnose the Sky installation, runtime, configuration, and workspace')
  .option('--json', 'Print stable JSON output')
  .action(async (options: { json?: boolean }) => {
    const json = options.json === true;
    try {
      const home = createSkyHome();
      let report: DiagnosticsReport;
      try {
        report = await getDaemonDiagnostics(home.socketFile);
        // The daemon cannot detect that it is stale, so compare from here. A
        // daemon predating this check still answers the status request.
        const daemonVersion = await daemonProductVersion(home.socketFile);
        if (daemonVersion) report = withDaemonVersionDrift(report, daemonVersion);
      } catch (error) {
        if (!controlUnavailable(error)) throw error;
        report = await runDiagnostics(home);
      }
      if (json) console.log(JSON.stringify(report, null, 2));
      else printHuman(report);
      process.exitCode = report.overall === 'fail' ? 1 : 0;
    } catch {
      if (json) {
        console.log(
          JSON.stringify(
            { error: { code: 'diagnostics_internal_error', message: 'Diagnostics could not run.' } },
            null,
            2,
          ),
        );
      } else {
        console.error('error: Diagnostics could not run.');
      }
      process.exitCode = 2;
    }
  });
