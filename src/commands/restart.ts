import { Command } from 'commander';
import { restartLaunchAgent } from '../service/launch-agent.js';
import { reportLifecycleError, reportStatusResult } from './service-output.js';

export const restartCommand = new Command('restart')
  .description('Gracefully restart the supervised daemon')
  .option('--force', 'Force replacement through launchctl when the daemon is unresponsive')
  .option('--json', 'Print stable JSON output')
  .action(async (options: { force?: boolean; json?: boolean }) => {
    const json = options.json === true;
    if (!json) console.error(options.force ? 'Force-restarting Sky…' : 'Restarting Sky…');
    try {
      reportStatusResult(await restartLaunchAgent({ force: options.force === true }), json);
    } catch (error) {
      reportLifecycleError(error, json);
    }
  });
