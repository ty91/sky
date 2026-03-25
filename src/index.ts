#!/usr/bin/env node
import { Command } from 'commander';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { restartCommand } from './commands/restart.js';
import { statusCommand } from './commands/status.js';
import { runCommand } from './commands/run.js';
import { logsCommand } from './commands/logs.js';

const program = new Command()
  .name('claudeclaw')
  .description('Telegram chatbot powered by Claude Agent SDK')
  .version('0.1.0');

program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(restartCommand);
program.addCommand(statusCommand);
program.addCommand(runCommand);
program.addCommand(logsCommand);

program.parse();
