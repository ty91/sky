import { Command } from 'commander';
import { adminCommand } from './commands/admin.js';
import { doctorCommand } from './commands/doctor.js';
import { dreamCommand } from './commands/dream.js';
import { initCommand } from './commands/init.js';
import { logsCommand } from './commands/logs.js';
import { memoryCommand } from './commands/memory.js';
import { operationCommand } from './commands/operation.js';
import { restartCommand } from './commands/restart.js';
import { serviceCommand } from './commands/service.js';
import { slackCommand } from './commands/slack.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';
import { PRODUCT_VERSION } from './product-version.js';

export async function runSky(userArgs: readonly string[]): Promise<void> {
  const program = new Command()
    .name('sky')
    .description('Pi coding agent chatbot for Slack')
    .version(PRODUCT_VERSION);

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
  program.addCommand(slackCommand);

  await program.parseAsync(userArgs, { from: 'user' });
}
