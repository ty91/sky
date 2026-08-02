import { Command } from 'commander';
import { showOperationStatus, watchOperationFromCli } from './operation-client.js';

const statusCommand = new Command('status')
  .description('Show the current state and result of an operation')
  .argument('<id>', 'operation ID')
  .option('--json', 'Print stable JSON output')
  .action((id: string, options: { json?: boolean }) =>
    showOperationStatus(id, options.json === true),
  );

const watchCommand = new Command('watch')
  .description('Attach to an operation event stream until it finishes')
  .argument('<id>', 'operation ID')
  .option('--json', 'Print events as JSONL')
  .action((id: string, options: { json?: boolean }) =>
    watchOperationFromCli(id, { json: options.json === true }),
  );

export const operationCommand = new Command('operation')
  .description('Inspect and watch daemon operations')
  .addCommand(statusCommand)
  .addCommand(watchCommand);
