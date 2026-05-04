import { Command } from 'commander';
import { isRunning, LOG_FILE, readPid, removePidFile } from '../daemon.js';
import { loadSettings, type Settings } from '../settings.js';

function tryLoadSettings(): Settings | undefined {
  try {
    return loadSettings({ silent: true });
  } catch {
    return undefined;
  }
}

function printSettings(settings: Settings | undefined): void {
  if (!settings) return;

  console.log('slack app: configured');
  console.log(`model: ${settings.model}`);
  console.log(`workspace: ${settings.workspace}`);
}

export const statusCommand = new Command('status')
  .description('Show daemon status')
  .action(() => {
    const settings = tryLoadSettings();
    const pid = readPid();
    if (isRunning(pid)) {
      console.log(`sky is running (pid: ${pid})`);
      console.log(`log: ${LOG_FILE}`);
      printSettings(settings);
      return;
    }

    if (pid) {
      removePidFile();
    }

    console.log('sky is stopped');
    console.log(`log: ${LOG_FILE}`);
    printSettings(settings);
  });
