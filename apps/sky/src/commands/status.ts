import { Command } from 'commander';
import { getServiceStatus } from '../service/launch-agent.js';
import { reportLifecycleError, reportStatusResult } from './service-output.js';

export const statusCommand = new Command('status')
  .description('Show combined launchd and daemon status')
  .option('--json', 'Print stable JSON output')
  .action(async (options: { json?: boolean }) => {
    const json = options.json === true;
    try {
      reportStatusResult(await getServiceStatus(), json);
    } catch (error) {
      reportLifecycleError(error, json);
    }
  });
