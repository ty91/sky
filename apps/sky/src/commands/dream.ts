import { Command } from 'commander';
import { createOperationFromCli } from './operation-client.js';

// L3 Dream Agent runs every day at 02:00 KST via cron.
// See docs/plans/active/2026-04-20-memory-v2-phase3-dream.md.

function assertDateKey(value: string): asserts value is string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`--date must be YYYY-MM-DD (got: ${value})`);
  }
}

function assertStep(value: string): asserts value is 'summarize' | 'knowledge' {
  if (value !== 'summarize' && value !== 'knowledge') {
    throw new Error(`--step must be "summarize" or "knowledge" (got: ${value})`);
  }
}

export const dreamCommand = new Command('dream')
  .description('Run the Dream Agent (L3 — daily summary + knowledge update, silent)')
  .option('--date <YYYY-MM-DD>', 'Target KST date (defaults to yesterday)')
  .option('--step <step>', 'Only run one step: summarize | knowledge')
  .option('--detach', 'Print the operation ID without waiting for completion')
  .action(async (opts: { date?: string; step?: string; detach?: boolean }) => {
    if (opts.date) assertDateKey(opts.date);
    let step: 'summarize' | 'knowledge' | undefined;
    if (opts.step) {
      assertStep(opts.step);
      step = opts.step;
    }

    await createOperationFromCli(
      {
        type: 'dream',
        ...(opts.date ? { date: opts.date } : {}),
        ...(step ? { step } : {}),
      },
      { detach: opts.detach === true },
    );
  });
