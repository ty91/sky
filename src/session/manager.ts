import type { AgentConfig } from '../agents/types.js';
import type { CollectOptions } from '../providers/types.js';
import type {
  Deferred,
  SendResult,
  SessionEntry,
  SessionManager,
  SessionManagerOptions,
} from './types.js';

export { type SendResult, type SessionManager, type SessionManagerOptions } from './types.js';

const DEFAULT_AGENT_MODEL = 'anthropic/claude-opus-4-7';

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Decide which system prompt to hand to the provider.
 *
 * - Resumed sessions replay the snapshot stored alongside the session id so
 *   the bytes match what Anthropic has already cached. Empty snapshots
 *   (legacy records from before we persisted prompts) fall back to the
 *   baseline prompt — the snapshot will be rewritten on the next successful
 *   turn.
 * - Fresh sessions invoke the loader, giving AGENTS.md / MEMORY.md edits a
 *   chance to apply without a bot restart. Agents that do not care about
 *   hot reload (e.g. the Memory Agent) simply omit the loader and reuse
 *   `agent.systemPrompt` unchanged.
 */
function resolveSystemPrompt(agent: AgentConfig, persistedPrompt?: string): string {
  if (persistedPrompt !== undefined) {
    return persistedPrompt || agent.systemPrompt;
  }
  return agent.systemPromptLoader ? agent.systemPromptLoader() : agent.systemPrompt;
}

function createProviderConfig(
  agent: AgentConfig,
  systemPrompt: string,
  options: SessionManagerOptions,
  sessionKey: string,
  resume?: string,
) {
  const mcpServers = agent.mcpServersFactory?.({ sessionKey });
  return {
    sessionKey,
    systemPrompt,
    model: agent.model ?? DEFAULT_AGENT_MODEL,
    tools: agent.tools,
    maxTurns: agent.maxTurns,
    cwd: agent.cwd ?? options.defaultCwd,
    ...(resume ? { resume } : {}),
    ...(mcpServers ? { mcpServers } : {}),
  };
}

function resolveAgentModel(agent: AgentConfig): string {
  return agent.model ?? DEFAULT_AGENT_MODEL;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const sessions = new Map<string, SessionEntry>();

  async function runWorker(key: string, entry: SessionEntry): Promise<void> {
    entry.workerRunning = true;

    while (entry.pending && !entry.closed) {
      const req = entry.pending;
      entry.pending = undefined;

      const turnId = ++entry.turnCounter;
      entry.activeTurnId = turnId;
      entry.activeTurnInterrupted = false;

      try {
        await entry.provider.send(req.text);
        const result = await entry.provider.collect({
          onMessage: req.collectOptions?.onMessage
            ? async (msg) => {
                // turnId 가드: stale turn의 콜백 차단
                if (entry.activeTurnId === turnId && !entry.activeTurnInterrupted) {
                  await req.collectOptions!.onMessage!(msg);
                }
              }
            : undefined,
        });

        if (entry.activeTurnInterrupted || entry.activeTurnId !== turnId || entry.closed) {
          req.deferred.resolve({ kind: 'interrupted' });
        } else {
          if (result.sessionId && result.sessionId !== entry.sessionId) {
            entry.sessionId = result.sessionId;
            // stale persist 방지: 아직 맵에 있는지 확인
            if (sessions.get(key) === entry) {
              options.store?.put(key, {
                sessionId: result.sessionId,
                model: entry.agent.model ?? DEFAULT_AGENT_MODEL,
                systemPrompt: entry.resolvedSystemPrompt,
              });
            }
          }
          req.deferred.resolve({ kind: 'ok', text: result.text });
        }
      } catch (error) {
        if (entry.activeTurnInterrupted || entry.activeTurnId !== turnId || entry.closed) {
          req.deferred.resolve({ kind: 'interrupted' });
        } else {
          req.deferred.resolve({ kind: 'error', error: toError(error) });
        }
      } finally {
        if (entry.activeTurnId === turnId) {
          entry.activeTurnId = undefined;
        }
      }
    }

    entry.workerRunning = false;
  }

  const manager: SessionManager = {
    open(key: string, agent: AgentConfig): void {
      if (sessions.has(key)) {
        return;
      }

      const currentModel = resolveAgentModel(agent);
      const persisted = options.store?.get(key);
      const resumable = persisted?.model === currentModel ? persisted : undefined;
      const resume = resumable?.sessionId;
      const systemPrompt = resolveSystemPrompt(agent, resumable?.systemPrompt);

      sessions.set(key, {
        provider: options.providerFactory.create(
          createProviderConfig(agent, systemPrompt, options, key, resume),
        ),
        agent,
        sessionId: resume,
        resolvedSystemPrompt: systemPrompt,
        turnCounter: 0,
        activeTurnInterrupted: false,
        workerRunning: false,
        closed: false,
      });

      // Legacy self-healing: a resumed record that predates prompt persistence
      // has systemPrompt === ''. Backfill it with the resolved snapshot so the
      // very next resume replays a matching prompt and hits Anthropic's cache.
      if (resume && resumable?.systemPrompt === '' && systemPrompt) {
        options.store?.put(key, { sessionId: resume, model: currentModel, systemPrompt });
      }
    },

    async send(key: string, text: string, collectOptions?: CollectOptions): Promise<SendResult> {
      const entry = sessions.get(key);
      if (!entry) {
        return { kind: 'error', error: new Error(`Session not open for key: ${key}`) };
      }

      const deferred = createDeferred<SendResult>();

      // 이전 pending이 있으면 즉시 interrupted로 resolve (latest-wins)
      if (entry.pending) {
        entry.pending.deferred.resolve({ kind: 'interrupted' });
      }

      entry.pending = { text, collectOptions, deferred };

      // active turn이 있으면 interrupt
      if (entry.activeTurnId !== undefined) {
        entry.activeTurnInterrupted = true;
        await entry.provider.interrupt();
      }

      // worker가 안 돌고 있으면 시작
      if (!entry.workerRunning) {
        void runWorker(key, entry);
      }

      return deferred.promise;
    },

    has(key: string, agent?: AgentConfig): boolean {
      if (sessions.has(key)) {
        return true;
      }

      const persisted = options.store?.get(key);
      if (!persisted) {
        return false;
      }

      return agent ? persisted.model === resolveAgentModel(agent) : true;
    },

    getSessionId(key: string): string | undefined {
      return sessions.get(key)?.sessionId;
    },

    async close(key: string): Promise<void> {
      const entry = sessions.get(key);
      if (!entry) {
        return;
      }

      entry.closed = true;
      sessions.delete(key);

      // pending이 있으면 interrupted로 resolve
      if (entry.pending) {
        entry.pending.deferred.resolve({ kind: 'interrupted' });
        entry.pending = undefined;
      }

      // active turn interrupt
      if (entry.activeTurnId !== undefined) {
        entry.activeTurnInterrupted = true;
        try {
          await entry.provider.interrupt();
        } catch {
          // interrupt 실패해도 close는 진행
        }
      }

      await entry.provider.close();
    },

    async purge(key: string): Promise<void> {
      await manager.close(key);
      options.store?.remove(key);
    },

    async closeAll(): Promise<void> {
      const keys = [...sessions.keys()];
      for (const key of keys) {
        await manager.close(key);
      }
    },
  };

  return manager;
}
