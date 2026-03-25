import { Command } from 'commander';
import { startDaemon, stopDaemon } from '../daemon.js';

export const restartCommand = new Command('restart')
  .description('Restart the daemon')
  .action(async () => {
    await stopDaemon();
    startDaemon();
  });
