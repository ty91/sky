import { createDefaultAgentSessionFactory } from '../agents/backend/index.js';
import type { AgentBackend, AgentSession } from '../agents/backend/types.js';
import type { AgentConfig } from '../agents/types.js';
import type {
  ConversationHandle,
  ConversationManager,
  ConversationManagerOptions,
  ConversationTurnOptions,
  ConversationTurnResult,
  PersistedConversation,
} from './types.js';

export type {
  ConversationHandle,
  ConversationManager,
  ConversationManagerOptions,
  ConversationStore,
  ConversationTurnOptions,
  ConversationTurnResult,
  PersistedConversation,
} from './types.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

type PendingTurn = {
  text: string;
  options?: ConversationTurnOptions;
  deferred: Deferred<ConversationTurnResult>;
};

type ConversationEntry = {
  key: string;
  backend: string;
  agentName: string;
  model: string;
  sessionPromise: Promise<AgentSession>;
  handle?: ConversationHandle;
  unsubscribe?: () => void;
  turnCounter: number;
  activeTurnId?: number;
  activeTurnInterrupted: boolean;
  activeText: string;
  activeDeltaTasks: Promise<void>[];
  activeOptions?: ConversationTurnOptions;
  pending?: PendingTurn;
  workerRunning: boolean;
  closed: boolean;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function resolveAgentModel(agent: AgentConfig): string {
  return agent.model ?? '';
}

function isConversationOwnedBy(
  conversation: PersistedConversation,
  agent: AgentConfig | undefined,
  agentBackend: AgentBackend,
): boolean {
  if (!agent) {
    return true;
  }
  return (
    conversation.agentName === agent.name &&
    conversation.model === resolveAgentModel(agent) &&
    conversation.backend === agentBackend
  );
}

function toHandle(session: AgentSession): ConversationHandle {
  return {
    sessionId: session.sessionId,
    ...(session.resumeRef !== undefined ? { sessionFile: session.resumeRef } : {}),
  };
}

function toPersistedHandle(conversation: PersistedConversation): ConversationHandle {
  return {
    sessionId: conversation.sessionId,
    ...(conversation.resumeRef !== undefined ? { sessionFile: conversation.resumeRef } : {}),
  };
}

function toResume(conversation: PersistedConversation): { sessionId: string; resumeRef?: string } {
  return {
    sessionId: conversation.sessionId,
    ...(conversation.resumeRef !== undefined ? { resumeRef: conversation.resumeRef } : {}),
  };
}

function wireStreaming(entry: ConversationEntry, session: AgentSession): void {
  if (entry.unsubscribe) {
    return;
  }

  entry.unsubscribe = session.subscribe((event) => {
    if (event.type !== 'text_delta' || entry.activeTurnId === undefined || entry.activeTurnInterrupted) {
      return;
    }

    entry.activeText += event.delta;
    const maybeTask = entry.activeOptions?.onTextDelta?.(event.delta);
    if (maybeTask) {
      entry.activeDeltaTasks.push(Promise.resolve(maybeTask));
    }
  });
}

async function runWorker(
  sessions: Map<string, ConversationEntry>,
  entry: ConversationEntry,
  persistConversation: (entry: ConversationEntry, handle: ConversationHandle) => void,
): Promise<void> {
  entry.workerRunning = true;

  while (entry.pending && !entry.closed) {
    const req = entry.pending;
    entry.pending = undefined;

    const turnId = ++entry.turnCounter;
    entry.activeTurnId = turnId;
    entry.activeTurnInterrupted = false;
    entry.activeText = '';
    entry.activeDeltaTasks = [];
    entry.activeOptions = req.options;

    try {
      const session = await entry.sessionPromise;
      wireStreaming(entry, session);

      await session.prompt(req.text);
      await Promise.all(entry.activeDeltaTasks);

      if (entry.activeTurnInterrupted || entry.activeTurnId !== turnId || entry.closed) {
        req.deferred.resolve({ kind: 'interrupted' });
      } else {
        const handle = toHandle(session);
        entry.handle = handle;
        persistConversation(entry, handle);
        req.deferred.resolve({
          kind: 'ok',
          text: entry.activeText,
          handle,
        });
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
      if (entry.activeOptions === req.options) {
        entry.activeOptions = undefined;
      }
    }
  }

  entry.workerRunning = false;

  if (entry.closed) {
    sessions.delete(entry.key);
  }
}

export function createConversationManager(options: ConversationManagerOptions): ConversationManager {
  const createSession = options.createSession ?? createDefaultAgentSessionFactory;
  const agentBackend = createSession.backend;
  const sessions = new Map<string, ConversationEntry>();

  function getPersistedConversation(
    key: string,
    agent?: AgentConfig,
  ): PersistedConversation | undefined {
    const persisted = options.store?.get(key, agentBackend);
    if (!persisted || !isConversationOwnedBy(persisted, agent, agentBackend)) {
      return undefined;
    }
    return persisted;
  }

  function persistConversation(entry: ConversationEntry, handle: ConversationHandle): void {
    if (!handle.sessionId || sessions.get(entry.key) !== entry) {
      return;
    }
    options.store?.put(entry.key, {
      sessionId: handle.sessionId,
      backend: entry.backend,
      model: entry.model,
      agentName: entry.agentName,
      ...(handle.sessionFile !== undefined ? { resumeRef: handle.sessionFile } : {}),
    });
  }

  async function getSession(entry: ConversationEntry): Promise<AgentSession> {
    const session = await entry.sessionPromise;
    wireStreaming(entry, session);
    return session;
  }

  const manager: ConversationManager = {
    async runTurn(key, agent, text, turnOptions) {
      let entry = sessions.get(key);
      if (!entry) {
        const cwd = agent.cwd ?? options.defaultCwd;
        const persisted = getPersistedConversation(key, agent);
        entry = {
          key,
          backend: agentBackend,
          agentName: agent.name,
          model: resolveAgentModel(agent),
          sessionPromise: createSession({
            key,
            agent,
            cwd,
            ...(persisted ? { resume: toResume(persisted) } : {}),
          }),
          ...(persisted ? { handle: toPersistedHandle(persisted) } : {}),
          turnCounter: 0,
          activeTurnInterrupted: false,
          activeText: '',
          activeDeltaTasks: [],
          workerRunning: false,
          closed: false,
        };
        sessions.set(key, entry);
      }

      const deferred = createDeferred<ConversationTurnResult>();

      if (entry.pending) {
        entry.pending.deferred.resolve({ kind: 'interrupted' });
      }
      entry.pending = { text, options: turnOptions, deferred };

      if (entry.activeTurnId !== undefined) {
        entry.activeTurnInterrupted = true;
        try {
          const session = await getSession(entry);
          await session.abort();
        } catch {
          // If session creation or abort fails, the active worker will resolve
          // the interrupted/error state through the normal prompt path.
        }
      }

      if (!entry.workerRunning) {
        void runWorker(sessions, entry, persistConversation);
      }

      return deferred.promise;
    },

    has(key, agent) {
      const entry = sessions.get(key);
      if (entry) {
        return (
          !agent ||
          (entry.agentName === agent.name &&
            entry.model === resolveAgentModel(agent) &&
            entry.backend === agentBackend)
        );
      }
      return getPersistedConversation(key, agent) !== undefined;
    },

    getHandle(key, agent) {
      const entry = sessions.get(key);
      if (entry) {
        if (
          agent &&
          (entry.agentName !== agent.name ||
            entry.model !== resolveAgentModel(agent) ||
            entry.backend !== agentBackend)
        ) {
          return undefined;
        }
        return entry.handle;
      }

      const persisted = getPersistedConversation(key, agent);
      return persisted ? toPersistedHandle(persisted) : undefined;
    },

    async close(key) {
      const entry = sessions.get(key);
      if (!entry) {
        return;
      }

      entry.closed = true;
      sessions.delete(key);
      if (entry.pending) {
        entry.pending.deferred.resolve({ kind: 'interrupted' });
        entry.pending = undefined;
      }
      if (entry.activeTurnId !== undefined) {
        entry.activeTurnInterrupted = true;
      }

      try {
        const session = await getSession(entry);
        if (entry.activeTurnId !== undefined) {
          await session.abort();
        }
        entry.unsubscribe?.();
        session.dispose();
      } catch {
        // close is best-effort once the entry has been removed from the map.
      }
    },

    async purge(key) {
      await manager.close(key);
      options.store?.remove(key, agentBackend);
    },

    async closeAll() {
      const keys = [...sessions.keys()];
      await Promise.all(keys.map((key) => manager.close(key)));
    },
  };

  return manager;
}
