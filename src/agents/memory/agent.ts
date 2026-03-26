import { randomUUID } from 'node:crypto';
import {
  query,
  type Options,
  type PermissionMode,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { getUnreadTranscripts, advanceCursors, type UnreadTranscript } from './cursors.js';
import { MEMORY_AGENT_SYSTEM_PROMPT } from './prompt.js';

const MEMORY_AGENT_MODEL = 'sonnet';

const MEMORY_AGENT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;

type MemoryAgentOptions = {
  workspace: string;
};

function isSystemInitMessage(message: SDKMessage): message is SDKSystemMessage {
  return message.type === 'system' && (message as SDKSystemMessage).subtype === 'init';
}

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

function buildOptions(workspace: string): Options {
  return {
    model: MEMORY_AGENT_MODEL,
    cwd: workspace,
    systemPrompt: MEMORY_AGENT_SYSTEM_PROMPT,
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'claudeclaw-memory/0.1.0',
    },
    tools: [...MEMORY_AGENT_TOOLS],
    permissionMode: 'bypassPermissions' as PermissionMode,
    settingSources: [],
  };
}

/**
 * Single async iterable that yields one user message then ends.
 */
async function* singleMessage(message: SDKUserMessage): AsyncIterable<SDKUserMessage> {
  yield message;
}

export type MemoryAgentResult = {
  processed: number;
  skipped: boolean;
  summary: string;
};

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
  const promptUuid = randomUUID();

  const userMessage: SDKUserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: userText }],
    },
    session_id: promptUuid,
    parent_tool_use_id: null,
    uuid: promptUuid,
  };

  const q = query({
    prompt: singleMessage(userMessage),
    options: buildOptions(options.workspace),
  });

  let finalText = '';

  while (true) {
    const { value: message, done } = await q.next();

    if (done || !message) break;

    if (isSystemInitMessage(message)) {
      console.log(`[memory-agent] session: ${message.session_id}`);
      continue;
    }

    if (message.type === 'assistant') {
      const blocks = message.message.content ?? [];
      for (const block of blocks) {
        if (block.type === 'text') {
          finalText = block.text;
        }
      }
      continue;
    }

    if (message.type === 'result') {
      if (message.subtype === 'success') {
        console.log('[memory-agent] completed successfully');
        break;
      }
      throw new Error(`Memory agent failed: ${message.errors.join('; ')}`);
    }
  }

  advanceCursors(transcripts);
  console.log(`[memory-agent] cursors advanced for ${transcripts.length} transcript(s)`);

  return {
    processed: transcripts.length,
    skipped: false,
    summary: finalText || '(No summary produced)',
  };
}
