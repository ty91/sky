import { Command } from 'commander';
import { createOperationFromCli } from './operation-client.js';

// L2 Working Memory Agent runs every 5 minutes via cron.
// Slack notifications are intentionally OFF — see docs/plans/active/2026-04-20-memory-v2.md.
// Phase 2/3/4 (dream, weekly, archive) will add their own Slack commands with prefixes.

export const memoryCommand = new Command('memory')
  .description('Run the Memory Agent (L2 working memory — silent, no Slack notification)')
  .option('--detach', 'Print the operation ID without waiting for completion')
  .action((options: { detach?: boolean }) =>
    createOperationFromCli({ type: 'memory' }, { detach: options.detach === true }),
  );
