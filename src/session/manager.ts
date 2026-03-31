import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentConfig } from '../agents/types.js';
import type { CollectOptions } from '../providers/types.js';
import { CLAUDECLAW_DIR } from '../settings.js';
import type {
  OpenSessionOptions,
  SendResult,
  SessionEntry,
  SessionManager,
  SessionManagerOptions,
} from './types.js';

export { type SendResult, type SessionManager, type SessionManagerOptions } from './types.js';

const SESSIONS_FILE = path.join(CLAUDECLAW_DIR, 'sessions.json');

function loadPersistedSessions(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function persistSession(chatId: string, sessionId: string): void {
  const data = loadPersistedSessions();
  data[chatId] = sessionId;
  mkdirSync(CLAUDECLAW_DIR, { recursive: true });
  writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

export function removePersistedSession(chatId: string): void {
  const data = loadPersistedSessions();
  delete data[chatId];
  mkdirSync(CLAUDECLAW_DIR, { recursive: true });
  writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

export function getPersistedSessionId(chatId: string): string | undefined {
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
