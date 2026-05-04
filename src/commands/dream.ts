import { Command } from 'commander';
import { loadSettings } from '../settings.js';
import { runDreamAgent, dreamDailyFilePath, type DreamStep } from '../agents/dream/agent.js';
import { createAcpProviderFactory } from '../providers/acp.js';
import { createSessionManager } from '../session/manager.js';

// L3 Dream Agent runs every day at 02:00 KST via cron.
// See docs/plans/active/2026-04-20-memory-v2-phase3-dream.md.

function assertDateKey(value: string): asserts value is string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`--date must be YYYY-MM-DD (got: ${value})`);
  }
}

function assertStep(value: string): asserts value is DreamStep {
  if (value !== 'summarize' && value !== 'knowledge') {
    throw new Error(`--step must be "summarize" or "knowledge" (got: ${value})`);
  }
}

export const dreamCommand = new Command('dream')
  .description('Run the Dream Agent (L3 — daily summary + knowledge update, silent)')
  .option('--date <YYYY-MM-DD>', 'Target KST date (defaults to yesterday)')
  .option('--step <step>', 'Only run one step: summarize | knowledge')
  .action(async (opts: { date?: string; step?: string }) => {
    if (opts.date) assertDateKey(opts.date);
    if (opts.step) assertStep(opts.step);

    const settings = loadSettings({ silent: true });
    console.log('[dream] starting L3 dream agent…');

    const sessionManager = createSessionManager({
      providerFactory: createAcpProviderFactory({ cwd: settings.workspace }),
      defaultCwd: settings.workspace,
    });

    const result = await runDreamAgent({
      sessionManager,
      workspace: settings.workspace,
      targetDate: opts.date,
      onlyStep: opts.step as DreamStep | undefined,
    });

    console.log(`[dream] target date: ${result.targetDate}`);
    console.log(`[dream] transcript entries: ${result.entryCount}`);
    console.log(`[dream] quiet day: ${result.quietDay}`);
    console.log(`[dream] daily file: ${dreamDailyFilePath(settings.workspace, result.targetDate)}`);

    if (result.summarize) {
      console.log(`[dream] step 1 summary: ${result.summarize.summary}`);
    }
    if (result.knowledge) {
      console.log(`[dream] step 2 summary: ${result.knowledge.summary}`);
    }

    console.log('[dream] done');
  });
