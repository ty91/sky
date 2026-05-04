import type { AgentConfig } from '../types.js';
import { getUnreadTranscripts, advanceCursors, type UnreadTranscript } from './cursors.js';
import { MEMORY_AGENT_SYSTEM_PROMPT } from './prompt.js';
import type { SessionManager } from '../../session/manager.js';

// L2 Working Memory Agent — see docs/plans/active/2026-04-20-memory-v2.md
// Fast, 5-minute polling cadence. Sonnet is sufficient for single-file rolling summary.
const MEMORY_AGENT_MODEL = 'anthropic/claude-sonnet-4-6';

const MEMORY_AGENT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;

/** Sentinel that the agent emits when it decides no meaningful update is needed. */
const SKIP_SENTINEL = 'SKIP';

type MemoryAgentOptions = {
  sessionManager: SessionManager;
  workspace: string;
};

function buildUserPrompt(transcripts: UnreadTranscript[]): string {
  const now = new Date();
  // `sv-SE` locale formats as `YYYY-MM-DD HH:mm:ss` — clean for Asia/Seoul.
  const kstNow = now.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });

  const parts = [
    '# L2 Working Memory Update',
    '',
    `**Current time (Asia/Seoul):** ${kstNow} KST`,
    `**Current time (UTC):** ${now.toISOString()}`,
    '',
    'Below are new transcript entries since your last run. Integrate these into ' +
      '`memory/_recent.md` per your system prompt rules. Keep only the last 24 hours ' +
      'of activity; drop anything older. If there is no meaningful update, output `SKIP`.',
    '',
  ];

  for (const t of transcripts) {
    parts.push(`## Transcript: ${t.relativePath}`);
    parts.push('');
    parts.push(t.newContent);
    parts.push('');
  }

  return parts.join('\n');
}

export type MemoryAgentResult = {
  processed: number;
  skipped: boolean;
  summary: string;
};

function createMemoryAgentConfig(workspace: string): AgentConfig {
  return {
    name: 'memory',
    systemPrompt: MEMORY_AGENT_SYSTEM_PROMPT,
    model: MEMORY_AGENT_MODEL,
    tools: [...MEMORY_AGENT_TOOLS],
    cwd: workspace,
  };
}

/**
 * Run the Memory Agent once: read unprocessed transcripts, invoke Claude to
 * update memory files, then advance cursors.
 */
export async function runMemoryAgent(options: MemoryAgentOptions): Promise<MemoryAgentResult> {
  const transcripts = getUnreadTranscripts();

  if (transcripts.length === 0) {
    return { processed: 0, skipped: true, summary: 'No new transcripts to process.' };
  }

  console.log(`[memory-agent] found ${transcripts.length} transcript(s) with new content`);
  for (const t of transcripts) {
    console.log(`[memory-agent]   ${t.relativePath} (+${t.newContent.length} bytes)`);
  }

  const userText = buildUserPrompt(transcripts);
  const key = 'memory:run';
  const memoryAgent = createMemoryAgentConfig(options.workspace);
  let finalText = '';

  options.sessionManager.open(key, memoryAgent);

  try {
    const result = await options.sessionManager.send(key, userText);
    if (result.kind === 'interrupted') {
      throw new Error('Memory agent session was unexpectedly interrupted');
    }
    if (result.kind === 'error') {
      throw new Error(`Memory agent failed: ${result.error.message}`);
    }

    finalText = result.text;

    // The L2 agent emits exactly "SKIP" when there is no meaningful update.
    const isSkip = finalText.trim() === SKIP_SENTINEL;

    if (isSkip) {
      console.log('[memory-agent] agent decided to SKIP (no meaningful update)');
    } else {
      console.log('[memory-agent] completed successfully');
    }

    // Advance cursors either way — we consumed the transcripts. A SKIP means
    // we intentionally chose not to rewrite _recent.md for these entries.
    advanceCursors(transcripts);
    console.log(`[memory-agent] cursors advanced for ${transcripts.length} transcript(s)`);

    if (isSkip) {
      return {
        processed: transcripts.length,
        skipped: true,
        summary: 'SKIP (no meaningful update)',
      };
    }
  } finally {
    await options.sessionManager.close(key);
  }

  return {
    processed: transcripts.length,
    skipped: false,
    summary: finalText || '(No summary produced)',
  };
}
