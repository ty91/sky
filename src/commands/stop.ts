import { Command } from 'commander';
import { stopDaemon } from '../daemon.js';

export const stopCommand = new Command('stop')
  .description('Stop the daemon')
  .action(async () => {
    await stopDaemon();
  });
