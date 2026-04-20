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
                systemPrompt: '',
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

      const persisted = options.store?.get(key);
      const resume = persisted?.sessionId;

      sessions.set(key, {
        provider: options.providerFactory.create(createProviderConfig(agent, options, resume)),
        agent,
        sessionId: resume,
        turnCounter: 0,
        activeTurnInterrupted: false,
        workerRunning: false,
        closed: false,
      });
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
