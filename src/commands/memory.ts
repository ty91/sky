import { Command } from 'commander';
import { loadSettings } from '../settings.js';
import { runMemoryAgent } from '../agents/memory/agent.js';
import { createAcpProviderFactory } from '../providers/acp.js';
import { createSessionManager } from '../session/manager.js';

// L2 Working Memory Agent runs every 5 minutes via cron.
// Slack notifications are intentionally OFF — see docs/plans/active/2026-04-20-memory-v2.md.
// Logs go to ~/.sky/memory-agent.log (stdout/stderr redirected by cron).
// Phase 2/3/4 (dream, weekly, archive) will add their own Slack commands with prefixes.

export const memoryCommand = new Command('memory')
  .description('Run the Memory Agent (L2 working memory — silent, no Slack notification)')
  .action(async () => {
    const settings = loadSettings({ silent: true });
    console.log('[memory] starting L2 working memory agent...');
    const sessionManager = createSessionManager({
      providerFactory: createAcpProviderFactory({ cwd: settings.workspace }),
      defaultCwd: settings.workspace,
    });

    const result = await runMemoryAgent({
      sessionManager,
      workspace: settings.workspace,
    });

    if (result.skipped) {
      console.log('[memory] skipped (no meaningful update)');
    } else {
      console.log(`[memory] processed ${result.processed} transcript(s)`);
      console.log(`[memory] summary: ${result.summary}`);
    }
  });
