import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TranscriptWriter } from '../agents/memory/transcript.js';
import type { AgentConfig } from '../agents/types.js';
import { createClaudeProviderFactory } from '../providers/claude.js';
import type { CollectOptions } from '../providers/types.js';
import { CLAUDECLAW_DIR } from '../settings.js';
import type {
  OpenSessionOptions,
  SendResult,
  SessionEntry,
  SessionManager,
  SessionManagerOptions,
} from './types.js';

export type HandleTextResult =
  | { kind: 'busy' }
  | { kind: 'ok'; reply: string };

export type OnAssistantMessage = (text: string) => Promise<void>;

export { type SendResult, type SessionManager, type SessionManagerOptions } from './types.js';

const DEFAULT_MAIN_TOOLS = [
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
] as const;

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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createProviderConfig(agent: AgentConfig, options: SessionManagerOptions, resume?: string) {
  return {
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    tools: agent.tools,
    maxTurns: agent.maxTurns,
    cwd: agent.cwd ?? options.defaultCwd,
    ...(resume ? { resume } : {}),
  };
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const sessions = new Map<string, SessionEntry>();

  return {
    open(key: string, agent: AgentConfig, sessionOptions?: OpenSessionOptions): void {
      if (sessions.has(key)) {
        return;
      }

      sessions.set(key, {
        provider: options.providerFactory.create(createProviderConfig(agent, options, sessionOptions?.resume)),
        busy: false,
        sessionId: sessionOptions?.resume,
      });
    },

    async send(key: string, text: string, collectOptions?: CollectOptions): Promise<SendResult> {
      const entry = sessions.get(key);
      if (!entry) {
        return { kind: 'error', error: new Error(`Session not open for key: ${key}`) };
      }

      if (entry.busy) {
        return { kind: 'busy' };
      }

      entry.busy = true;

      try {
        await entry.provider.send(text);
        const result = await entry.provider.collect(collectOptions);
        if (result.sessionId && result.sessionId !== entry.sessionId) {
          entry.sessionId = result.sessionId;
          options.onSessionCreated?.(key, result.sessionId);
        }
        return { kind: 'ok', text: result.text };
      } catch (error) {
        return { kind: 'error', error: toError(error) };
      } finally {
        entry.busy = false;
      }
    },

    getSessionId(key: string): string | undefined {
      return sessions.get(key)?.sessionId;
    },

    async close(key: string): Promise<void> {
      const entry = sessions.get(key);
      if (!entry) {
        return;
      }

      sessions.delete(key);
      await entry.provider.close();
    },

    async closeAll(): Promise<void> {
      const keys = [...sessions.keys()];
      for (const key of keys) {
        await this.close(key);
      }
    },
  };
}

export class ClaudeSessionManager {
  private readonly sessionManager: SessionManager;
  private readonly agent: AgentConfig;
  private readonly transcripts = new Map<string, TranscriptWriter>();

  constructor(options: { model: string; workspace: string; systemPrompt: string }) {
    this.agent = {
      name: 'main',
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: [...DEFAULT_MAIN_TOOLS],
    };
    this.sessionManager = createSessionManager({
      providerFactory: createClaudeProviderFactory({ cwd: options.workspace }),
      defaultCwd: options.workspace,
      onSessionCreated: (chatId, sessionId) => {
        if (getPersistedSessionId(chatId) === sessionId) {
          return;
        }

        persistSession(chatId, sessionId);
        console.log(`[session] persisted session ${sessionId} for chat ${chatId}`);
      },
    });
  }

  prepareFreshSession(chatId: string): void {
    this.resetChatSession(chatId);
    this.sessionManager.open(chatId, this.agent);
  }

  async handleText(
    chatId: string,
    userText: string,
    onMessage?: OnAssistantMessage,
  ): Promise<HandleTextResult> {
    this.openChatSession(chatId);

    const transcript = this.getTranscript(chatId);
    const sessionId = this.sessionManager.getSessionId(chatId);
    if (sessionId) {
      transcript.setSessionId(sessionId);
    }
    transcript.appendUser(userText);

    const result = await this.sessionManager.send(chatId, userText, {
      onMessage: async (text) => {
        transcript.appendAssistant(text);
        if (!onMessage) {
          return;
        }

        try {
          await onMessage(text);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[query] onMessage error: ${message}`);
        }
      },
    });

    if (result.kind === 'error') {
      throw result.error;
    }

    if (result.kind === 'busy') {
      return { kind: 'busy' };
    }

    const updatedSessionId = this.sessionManager.getSessionId(chatId);
    if (updatedSessionId) {
      transcript.setSessionId(updatedSessionId);
    }

    return { kind: 'ok', reply: result.text };
  }

  resetChatSession(chatId: string): void {
    void this.sessionManager.close(chatId).catch((error) => {
      console.error(`[session] failed to close session for chat ${chatId}: ${toError(error).message}`);
    });
    this.transcripts.delete(chatId);
    removePersistedSession(chatId);
    console.log(`[session] reset session for chat ${chatId}`);
  }

  closeAll(): void {
    void this.sessionManager.closeAll().catch((error) => {
      console.error(`[session] failed to close all sessions: ${toError(error).message}`);
    });
  }

  private openChatSession(chatId: string): void {
    const resume = getPersistedSessionId(chatId);
    if (resume) {
      console.log(`[session] resuming session ${resume} for chat ${chatId}`);
    }

    this.sessionManager.open(chatId, this.agent, { resume });
  }

  private getTranscript(chatId: string): TranscriptWriter {
    let transcript = this.transcripts.get(chatId);
    if (!transcript) {
      transcript = new TranscriptWriter(chatId);
      this.transcripts.set(chatId, transcript);
    }
    return transcript;
  }
}
