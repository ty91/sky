import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Telegraf } from 'telegraf';
import {
  query,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

export type ChatState = {
  query: Query;
  input: Pushable<SDKUserMessage>;
  busy: boolean;
  sessionId?: string;
};

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

const CLAUDECLAW_DIR = path.join(os.homedir(), '.claudeclaw');
const SESSIONS_FILE = path.join(CLAUDECLAW_DIR, 'telegram-sessions.json');

function loadPersistedSessions(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function persistSession(chatId: number, sessionId: string): void {
  const data = loadPersistedSessions();
  data[String(chatId)] = sessionId;
  mkdirSync(CLAUDECLAW_DIR, { recursive: true });
  writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

function removePersistedSession(chatId: number): void {
  const data = loadPersistedSessions();
  delete data[String(chatId)];
  writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

function getPersistedSessionId(chatId: number): string | undefined {
  return loadPersistedSessions()[String(chatId)];
}

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.CLAUDE_MODEL || 'sonnet';
const soulPath = process.env.CLAUDE_SYSTEM_PROMPT_FILE || '/Users/taeyoung/.claudeclaw/workspace/SOUL.md';
const userPath = process.env.CLAUDE_USER_PROMPT_FILE || '/Users/taeyoung/.claudeclaw/workspace/USER.md';

function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function loadCombinedPrompt(): string {
  const soul = safeRead(soulPath);
  const user = safeRead(userPath);

  if (soul && user) return `${soul}\n\n${user}`;
  return soul || user || '';
}

const combinedPrompt = loadCombinedPrompt();

function buildOptions(resumeId?: string): Options {
  return {
    model,
    systemPrompt: combinedPrompt,
    ...(resumeId ? { resume: resumeId } : {}),
    env: {
      ...process.env,
      ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
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

function createChatSession(chatId: number, sessions: Map<number, ChatState>): ChatState {
  const savedSessionId = getPersistedSessionId(chatId);
  if (savedSessionId) {
    console.log(`[session] resuming session ${savedSessionId} for chat ${chatId}`);
  }

  const input = new Pushable<SDKUserMessage>();
  const q = query({
    prompt: input,
    options: buildOptions(savedSessionId),
  });

  const state: ChatState = {
    query: q,
    input,
    busy: false,
  };

  sessions.set(chatId, state);
  return state;
}

function getOrCreateChatSession(chatId: number, sessions: Map<number, ChatState>): ChatState {
  return sessions.get(chatId) ?? createChatSession(chatId, sessions);
}

async function resetChatSession(chatId: number, sessions: Map<number, ChatState>): Promise<void> {
  const existing = sessions.get(chatId);
  if (!existing) return;

  existing.input.end();
  existing.query.close();
  sessions.delete(chatId);
  removePersistedSession(chatId);
  console.log(`[session] reset session for chat ${chatId}`);
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

async function runTurn(state: ChatState, userText: string): Promise<string> {
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

export async function startBot(): Promise<void> {
  if (!telegramToken) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and set it.');
  }

  const bot = new Telegraf(telegramToken);
  const sessions = new Map<number, ChatState>();

  bot.start(async (ctx) => {
    console.log(`[telegram] /start from chat ${ctx.chat.id}`);
    await resetChatSession(ctx.chat.id, sessions);
    createChatSession(ctx.chat.id, sessions);

    await ctx.reply(
      '안녕하세요. 이 봇은 채팅방별로 long-lived query 세션을 유지합니다.\n\n' +
        '- 같은 채팅방 메시지는 같은 query에 계속 들어갑니다\n' +
        '- /new 로 세션을 초기화할 수 있습니다\n' +
        '- system prompt는 SOUL.md + USER.md를 조립해서 사용합니다'
    );
  });

  bot.command('new', async (ctx) => {
    console.log(`[telegram] /new from chat ${ctx.chat.id}`);
    await resetChatSession(ctx.chat.id, sessions);
    createChatSession(ctx.chat.id, sessions);
    await ctx.reply('새 세션으로 초기화했습니다. 이제 새 query로 다시 시작합니다.');
  });

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text.trim();
    console.log(`[telegram] text from ${chatId}: ${JSON.stringify(userText)}`);

    if (!userText) {
      await ctx.reply('빈 메시지는 처리할 수 없습니다.');
      return;
    }

    const state = getOrCreateChatSession(chatId, sessions);

    if (state.busy) {
      await ctx.reply('지금 이전 요청을 처리 중입니다. 잠시 후 다시 보내주세요.');
      return;
    }

    state.busy = true;

    try {
      await ctx.sendChatAction('typing');
      const reply = await runTurn(state, userText);

      if (state.sessionId) {
        const sessionId = state.sessionId;
        if (getPersistedSessionId(chatId) !== sessionId) {
          persistSession(chatId, sessionId);
          console.log(`[session] persisted session ${sessionId} for chat ${chatId}`);
        }
      }

      const chunks = reply.match(/[\s\S]{1,3500}/g) ?? ['(빈 응답)'];
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`오류가 났습니다: ${message}`);
    } finally {
      state.busy = false;
    }
  });

  async function launchBotWithRetry() {
    let attempt = 0;

    while (true) {
      attempt += 1;
      try {
        await bot.launch();
        console.log(`Telegram bot started with Claude model: ${model}`);
        console.log(`System prompt sources: ${soulPath} + ${userPath}`);
        console.log('Mode: long-lived query + pushable input');
        console.log(`Launch succeeded on attempt ${attempt}`);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Bot launch failed on attempt ${attempt}: ${message}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      for (const state of sessions.values()) {
        state.input.end();
        state.query.close();
      }
      bot.stop(signal);
    });
  }

  await launchBotWithRetry();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startBot().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
