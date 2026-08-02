import { Command } from 'commander';
import { stopLaunchAgent } from '../service/launch-agent.js';
import { printJson, printStatus, reportLifecycleError } from './service-output.js';

export const stopCommand = new Command('stop')
  .description('Stop the Sky LaunchAgent while preserving its plist')
  .option('--json', 'Print stable JSON output')
  .action(async (options: { json?: boolean }) => {
    const json = options.json === true;
    if (!json) console.error('Stopping Sky…');
    try {
      const status = await stopLaunchAgent();
      if (json) {
        printJson({ ok: true, status });
      } else {
        console.log('Sky stopped. LaunchAgent registration was preserved.');
        printStatus(status);
      }
    } catch (error) {
      reportLifecycleError(error, json);
    }
  });
