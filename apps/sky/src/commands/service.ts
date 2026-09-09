import { Command } from 'commander';
import {
  getServiceStatus,
  installLaunchAgent,
  uninstallLaunchAgent,
} from '../service/launch-agent.js';
import {
  printJson,
  printStatus,
  reportInstallResult,
  reportLifecycleError,
  reportStatusResult,
} from './service-output.js';

type JsonOptions = { json?: boolean };

const installCommand = new Command('install')
  .description('Install or reconcile the macOS user LaunchAgent')
  .option('--json', 'Print stable JSON output')
  .action(async (options: JsonOptions) => {
    const json = options.json === true;
    if (!json) console.error('Reconciling the Sky LaunchAgent…');
    try {
      reportInstallResult(await installLaunchAgent(), json);
    } catch (error) {
      reportLifecycleError(error, json);
    }
  });

const uninstallCommand = new Command('uninstall')
  .description('Unload the macOS user LaunchAgent and remove its plist')
  .option('--json', 'Print stable JSON output')
  .action(async (options: JsonOptions) => {
    const json = options.json === true;
    if (!json) console.error('Unloading the Sky LaunchAgent…');
    try {
      const status = await uninstallLaunchAgent();
      if (json) {
        printJson({ ok: true, status });
      } else {
        console.log('LaunchAgent uninstalled. Sky data was preserved.');
        printStatus(status);
      }
    } catch (error) {
      reportLifecycleError(error, json);
    }
  });

const statusCommand = new Command('status')
  .description('Show LaunchAgent and daemon status')
  .option('--json', 'Print stable JSON output')
  .action(async (options: JsonOptions) => {
    const json = options.json === true;
    try {
      reportStatusResult(await getServiceStatus(), json);
    } catch (error) {
      reportLifecycleError(error, json);
    }
  });

export const serviceCommand = new Command('service')
  .description('Manage persistent LaunchAgent registration')
  .addCommand(statusCommand)
  .addCommand(installCommand)
  .addCommand(uninstallCommand);
