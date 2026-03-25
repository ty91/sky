import { Command } from 'commander';
import { isRunning, LOG_FILE, readPid, removePidFile } from '../daemon.js';

export const statusCommand = new Command('status')
  .description('Show daemon status')
  .action(() => {
    const pid = readPid();
    if (isRunning(pid)) {
      console.log(`claudeclaw is running (pid: ${pid})`);
      console.log(`log: ${LOG_FILE}`);
      return;
    }

    if (pid) {
      removePidFile();
    }

    console.log('claudeclaw is stopped');
  });
