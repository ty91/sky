#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { restartCommand } from './commands/restart.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';
import { memoryCommand } from './commands/memory.js';
import { dreamCommand } from './commands/dream.js';
import { serviceCommand } from './commands/service.js';
import { operationCommand } from './commands/operation.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { adminCommand } from './commands/admin.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const program = new Command()
  .name('sky')
  .description('Pi coding agent chatbot for Slack')
  .version(version);

program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(restartCommand);
program.addCommand(statusCommand);
program.addCommand(serviceCommand);
program.addCommand(logsCommand);
program.addCommand(memoryCommand);
program.addCommand(dreamCommand);
program.addCommand(operationCommand);
program.addCommand(doctorCommand);
program.addCommand(initCommand);
program.addCommand(adminCommand);

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
