import { Command } from 'commander';
import { startDaemon } from '../daemon.js';

export const startCommand = new Command('start')
  .description('Start claudeclaw as a daemon')
  .action(() => {
    startDaemon();
  });
