import type { AgentConfig } from '../types.js';
import { getUnreadTranscripts, advanceCursors, type UnreadTranscript } from './cursors.js';
import { MEMORY_AGENT_SYSTEM_PROMPT } from './prompt.js';
import type { SessionManager } from '../../session/manager.js';

const MEMORY_AGENT_MODEL = 'sonnet';

const MEMORY_AGENT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;

type MemoryAgentOptions = {
  sessionManager: SessionManager;
  workspace: string;
};

function buildUserPrompt(transcripts: UnreadTranscript[]): string {
  const parts = ['# New Conversation Transcripts\n'];
  parts.push('Process the following new conversation excerpts and update memory accordingly.\n');

  for (const t of transcripts) {
    parts.push(`## Transcript: ${t.relativePath}\n`);
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
    if (result.kind === 'busy') {
      throw new Error('Memory agent session is unexpectedly busy');
    }
    if (result.kind === 'error') {
      throw new Error(`Memory agent failed: ${result.error.message}`);
    }

    finalText = result.text;
    console.log('[memory-agent] completed successfully');

    advanceCursors(transcripts);
    console.log(`[memory-agent] cursors advanced for ${transcripts.length} transcript(s)`);
  } finally {
    await options.sessionManager.close(key);
  }

  return {
    processed: transcripts.length,
    skipped: false,
    summary: finalText || '(No summary produced)',
  };
}
