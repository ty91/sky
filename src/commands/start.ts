import { Command } from 'commander';
import { startLaunchAgent } from '../service/launch-agent.js';
import { reportLifecycleError, reportStatusResult } from './service-output.js';

export const startCommand = new Command('start')
  .description('Start the installed Sky LaunchAgent')
  .option('--json', 'Print stable JSON output')
  .action(async (options: { json?: boolean }) => {
    const json = options.json === true;
    if (!json) console.error('Starting Sky…');
    try {
      reportStatusResult(await startLaunchAgent(), json);
    } catch (error) {
      reportLifecycleError(error, json);
    }
  });
