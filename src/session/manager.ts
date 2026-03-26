import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  query,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { CLAUDECLAW_DIR } from '../settings.js';

export type SessionManagerOptions = {
  model: string;
  workspace: string;
  systemPrompt: string;
};

type ChatState = {
  query: Query;
  input: Pushable<SDKUserMessage>;
  busy: boolean;
  sessionId?: string;
};

export type HandleTextResult =
  | { kind: 'busy' }
  | { kind: 'ok'; reply: string };

export type OnStreamChunk = (delta: string) => Promise<void>;

class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T) {
    if (this.ended) {
      throw new Error('Cannot push to a closed Pushable');
    }

    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
      return;
    }

    this.queue.push(value);
  }

  end() {
    this.ended = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          return { value, done: false };
        }

        if (this.ended) {
          return { value: undefined as T, done: true };
        }

        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

const SESSIONS_FILE = path.join(CLAUDECLAW_DIR, 'sessions.json');

function loadPersistedSessions(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function persistSession(chatId: string, sessionId: string): void {
  const data = loadPersistedSessions();
  data[chatId] = sessionId;
  mkdirSync(CLAUDECLAW_DIR, { recursive: true });
  writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

function removePersistedSession(chatId: string): void {
  const data = loadPersistedSessions();
  delete data[chatId];
  writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

function getPersistedSessionId(chatId: string): string | undefined {
  return loadPersistedSessions()[chatId];
}

function extractTextFromMessage(message: SDKMessage): string {
  if (message.type !== 'assistant') return '';

  const blocks = message.message.content ?? [];
  const texts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      texts.push(block.text);
    }
  }

  return texts.join('\n').trim();
}

function isSystemInitMessage(message: SDKMessage): message is SDKSystemMessage {
  return message.type === 'system' && (message as SDKSystemMessage).subtype === 'init';
}

export class ClaudeSessionManager {
  private readonly sessions = new Map<string, ChatState>();

  constructor(private readonly options: SessionManagerOptions) {}

  prepareFreshSession(chatId: string): void {
    this.resetChatSession(chatId);
    this.createChatSession(chatId);
  }

  async handleText(chatId: string, userText: string): Promise<HandleTextResult> {
    const state = this.getOrCreateChatSession(chatId);
    if (state.busy) {
      return { kind: 'busy' };
    }

    state.busy = true;

    try {
      const reply = await this.runTurn(state, userText);
      this.persistIfNeeded(chatId, state);
      return { kind: 'ok', reply };
    } finally {
      state.busy = false;
    }
  }

  async handleTextStreaming(
    chatId: string,
    userText: string,
    onChunk: OnStreamChunk,
  ): Promise<HandleTextResult> {
    const state = this.getOrCreateChatSession(chatId);
    if (state.busy) {
      return { kind: 'busy' };
    }

    state.busy = true;

    try {
      const reply = await this.runTurnStreaming(state, userText, onChunk);
      this.persistIfNeeded(chatId, state);
      return { kind: 'ok', reply };
    } finally {
      state.busy = false;
    }
  }

  private persistIfNeeded(chatId: string, state: ChatState): void {
    if (state.sessionId) {
      const sessionId = state.sessionId;
      if (getPersistedSessionId(chatId) !== sessionId) {
        persistSession(chatId, sessionId);
        console.log(`[session] persisted session ${sessionId} for chat ${chatId}`);
      }
    }
  }

  resetChatSession(chatId: string): void {
    const existing = this.sessions.get(chatId);
    if (!existing) return;

    existing.input.end();
    existing.query.close();
    this.sessions.delete(chatId);
    removePersistedSession(chatId);
    console.log(`[session] reset session for chat ${chatId}`);
  }

  closeAll(): void {
    for (const [chatId, state] of this.sessions.entries()) {
      state.input.end();
      state.query.close();
      this.sessions.delete(chatId);
    }
  }

  private buildOptions(resumeId?: string): Options {
    return {
      model: this.options.model,
      cwd: this.options.workspace,
      systemPrompt: this.options.systemPrompt,
      ...(resumeId ? { resume: resumeId } : {}),
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: 'claudeclaw/0.5.0',
      },
      tools: [
        'Bash',
        'Glob',
        'Grep',
        'Read',
        'Edit',
        'Write',
        'Skill',
        'TaskOutput',
        'TaskStop',
        'TodoWrite',
        'WebFetch',
        'WebSearch',
      ],
      permissionMode: 'bypassPermissions' as PermissionMode,
      includePartialMessages: true,
      settingSources: [],
      ...({ extraArgs: { 'replay-user-messages': '' } } as unknown as {}),
    };
  }

  private createChatSession(chatId: string): ChatState {
    const savedSessionId = getPersistedSessionId(chatId);
    if (savedSessionId) {
      console.log(`[session] resuming session ${savedSessionId} for chat ${chatId}`);
    }

    const input = new Pushable<SDKUserMessage>();
    const q = query({
      prompt: input,
      options: this.buildOptions(savedSessionId),
    });

    const state: ChatState = {
      query: q,
      input,
      busy: false,
    };

    this.sessions.set(chatId, state);
    return state;
  }

  private getOrCreateChatSession(chatId: string): ChatState {
    return this.sessions.get(chatId) ?? this.createChatSession(chatId);
  }

  private async runTurnStreaming(
    state: ChatState,
    userText: string,
    onChunk: OnStreamChunk,
  ): Promise<string> {
    console.log(`[query] runTurnStreaming start: ${JSON.stringify(userText)}`);
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

    state.input.push(userMessage);

    let emittedLength = 0;
    let finalText = '';
    let promptReplayed = false;

    while (true) {
      const { value: message, done } = await state.query.next();
      if (message) {
        console.log(`[query] message type=${message.type}${message.type === 'system' ? ` subtype=${message.subtype}` : ''}`);
      } else if (done) {
        console.log('[query] done=true');
      }

      if (done || !message) {
        break;
      }

      if (isSystemInitMessage(message)) {
        state.sessionId = message.session_id;
        continue;
      }

      if (message.type === 'user' && 'uuid' in message && message.uuid === promptUuid) {
        promptReplayed = true;
        continue;
      }

      if (message.type === 'assistant') {
        const text = extractTextFromMessage(message);
        if (text) {
          finalText = text;
          if (text.length > emittedLength) {
            const delta = text.slice(emittedLength);
            emittedLength = text.length;
            try {
              await onChunk(delta);
            } catch (err) {
              console.error(`[query] onChunk error: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
        continue;
      }

      if (message.type === 'result') {
        if (!promptReplayed) {
          continue;
        }

        if (message.subtype === 'success') {
          console.log('[query] success result received');
          return finalText || message.result || '(No text response)';
        }

        throw new Error(message.errors.join('; ') || 'Claude returned an error');
      }
    }

    return finalText || '(No response)';
  }

  private async runTurn(state: ChatState, userText: string): Promise<string> {
    console.log(`[query] runTurn start: ${JSON.stringify(userText)}`);
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

    state.input.push(userMessage);

    let finalText = '';
    let promptReplayed = false;

    while (true) {
      const { value: message, done } = await state.query.next();
      if (message) {
        console.log(`[query] message type=${message.type}${message.type === 'system' ? ` subtype=${message.subtype}` : ''}`);
      } else if (done) {
        console.log('[query] done=true');
      }

      if (done || !message) {
        break;
      }

      if (isSystemInitMessage(message)) {
        state.sessionId = message.session_id;
        continue;
      }

      if (message.type === 'user' && 'uuid' in message && message.uuid === promptUuid) {
        promptReplayed = true;
        continue;
      }

      if (message.type === 'assistant') {
        const text = extractTextFromMessage(message);
        if (text) finalText = text;
        continue;
      }

      if (message.type === 'result') {
        if (!promptReplayed) {
          continue;
        }

        if (message.subtype === 'success') {
          console.log('[query] success result received');
          return finalText || message.result || '(No text response)';
        }

        throw new Error(message.errors.join('; ') || 'Claude returned an error');
      }
    }

    return finalText || '(No response)';
  }
}
