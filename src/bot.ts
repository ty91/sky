import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Bot } from 'grammy';
import {
  query,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { CLAUDECLAW_DIR, loadSettings } from './settings.js';

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

function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
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
  console.log('[startup] loading settings...');
  const settings = loadSettings();
  const { workspace } = settings;
  const model = settings.claude.model;
  console.log(`[startup] model: ${model}`);
  console.log(`[startup] workspace: ${workspace}`);

  const PROMPT_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md'] as const;
  const loaded: string[] = [];
  const missing: string[] = [];
  const promptParts: string[] = [];

  for (const f of PROMPT_FILES) {
    const content = safeRead(path.join(workspace, f));
    if (content) {
      loaded.push(f);
      promptParts.push(content);
    } else {
      missing.push(f);
    }
  }

  console.log(`[startup] prompt files loaded: ${loaded.join(', ') || '(none)'}`);
  if (missing.length) {
    console.log(`[startup] prompt files missing: ${missing.join(', ')}`);
  }

  const combinedPrompt = promptParts.join('\n\n');
  console.log(`[startup] system prompt length: ${combinedPrompt.length} chars`);

  function buildOptions(resumeId?: string): Options {
    return {
      model,
      cwd: workspace,
      systemPrompt: combinedPrompt,
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

  function createChatSession(chatId: number): ChatState {
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

  function getOrCreateChatSession(chatId: number): ChatState {
    return sessions.get(chatId) ?? createChatSession(chatId);
  }

  async function resetChatSession(chatId: number): Promise<void> {
    const existing = sessions.get(chatId);
    if (!existing) return;

    existing.input.end();
    existing.query.close();
    sessions.delete(chatId);
    removePersistedSession(chatId);
    console.log(`[session] reset session for chat ${chatId}`);
  }

  const bot = new Bot(settings.telegram.botToken);
  const sessions = new Map<number, ChatState>();

  bot.command('start', async (ctx) => {
    console.log(`[telegram] /start from chat ${ctx.chat.id}`);
    await resetChatSession(ctx.chat.id);
    createChatSession(ctx.chat.id);

    await ctx.reply(
      '안녕하세요. 이 봇은 채팅방별로 long-lived query 세션을 유지합니다.\n\n' +
        '- 같은 채팅방 메시지는 같은 query에 계속 들어갑니다\n' +
        '- /new 로 세션을 초기화할 수 있습니다\n' +
        '- system prompt는 SOUL.md + USER.md를 조립해서 사용합니다'
    );
  });

  bot.command('new', async (ctx) => {
    console.log(`[telegram] /new from chat ${ctx.chat.id}`);
    await resetChatSession(ctx.chat.id);
    createChatSession(ctx.chat.id);
    await ctx.reply('새 세션으로 초기화했습니다. 이제 새 query로 다시 시작합니다.');
  });

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text.trim();
    console.log(`[telegram] text from ${chatId}: ${JSON.stringify(userText)}`);

    if (!userText) {
      await ctx.reply('빈 메시지는 처리할 수 없습니다.');
      return;
    }

    const state = getOrCreateChatSession(chatId);

    if (state.busy) {
      await ctx.reply('지금 이전 요청을 처리 중입니다. 잠시 후 다시 보내주세요.');
      return;
    }

    state.busy = true;

    await ctx.replyWithChatAction('typing');
    const typingInterval = setInterval(() => ctx.replyWithChatAction('typing'), 4000);

    try {
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
      clearInterval(typingInterval);
      state.busy = false;
    }
  });

  async function launchBotWithRetry() {
    let attempt = 0;

    while (true) {
      attempt += 1;
      try {
        await bot.init();
        console.log(`[startup] telegram bot connected as @${bot.botInfo.username}`);
        console.log(`[startup] launch succeeded on attempt ${attempt}`);
        bot.start();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[startup] bot launch failed on attempt ${attempt}: ${message}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      for (const state of sessions.values()) {
        state.input.end();
        state.query.close();
      }
      await bot.stop();
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
