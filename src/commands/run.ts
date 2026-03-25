import { Command } from 'commander';
import { startBot } from '../bot.js';

export const runCommand = new Command('run')
  .description('Run in foreground')
  .action(async () => {
    await startBot();
  });
