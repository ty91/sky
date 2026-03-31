import { Command } from 'commander';
import { loadSettings } from '../settings.js';
import { runMemoryAgent, type MemoryAgentResult } from '../agents/memory/agent.js';
import { createClaudeProviderFactory } from '../providers/claude.js';
import { createSessionManager } from '../session/manager.js';

const MEMORY_LOG_CHANNEL = 'C0APGL1DKDH';

async function postToSlack(botToken: string, result: MemoryAgentResult): Promise<void> {
  const text = `📝 Processed *${result.processed}* transcript(s).\n\n${result.summary}`;

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel: MEMORY_LOG_CHANNEL, text }),
  });

  const body = (await res.json()) as { ok: boolean; error?: string };
  if (!body.ok) {
    console.error(`[memory] slack notification failed: ${body.error}`);
  }
}

export const memoryCommand = new Command('memory')
  .description('Run the Memory Agent to process new transcripts')
  .action(async () => {
    const settings = loadSettings({ silent: true });
    console.log('[memory] starting memory agent...');
    const sessionManager = createSessionManager({
      providerFactory: createClaudeProviderFactory({ cwd: settings.workspace }),
      defaultCwd: settings.workspace,
    });

    const result = await runMemoryAgent({
      sessionManager,
      workspace: settings.workspace,
    });

    if (result.skipped) {
      console.log('[memory] no new transcripts to process');
    } else {
      console.log(`[memory] processed ${result.processed} transcript(s)`);
      console.log(`[memory] summary: ${result.summary}`);
    }

    if (settings.slack && !result.skipped) {
      try {
        await postToSlack(settings.slack.botToken, result);
        console.log('[memory] slack notification sent');
      } catch (error) {
        console.error(`[memory] slack notification error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
