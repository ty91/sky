import { Command } from 'commander';
import { loadSettings } from '../settings.js';
import { runMemoryAgent } from '../agents/memory/agent.js';

export const memoryCommand = new Command('memory')
  .description('Run the Memory Agent to process new transcripts')
  .action(async () => {
    const settings = loadSettings({ silent: true });
    console.log('[memory] starting memory agent...');

    const result = await runMemoryAgent({ workspace: settings.workspace });

    if (result.skipped) {
      console.log('[memory] no new transcripts to process');
    } else {
      console.log(`[memory] processed ${result.processed} transcript(s)`);
      console.log(`[memory] summary: ${result.summary}`);
    }
  });
