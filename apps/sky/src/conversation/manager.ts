import { createDefaultAgentSessionFactory } from '../agents/backend/index.js';
import type { AgentBackend, AgentSession } from '../agents/backend/types.js';
import type { AgentConfig } from '../agents/types.js';
import { createInMemoryConversationStore, UnknownConversationError } from './store.js';
import type {
  ConversationHandle,
  ConversationManager,
  ConversationManagerOptions,
  ConversationSummary,
  ConversationTurnOptions,
  ConversationTurnResult,
  PersistedSession,
} from './types.js';

export type {
  ConversationHandle,
  ConversationLink,
  ConversationManager,
  ConversationManagerOptions,
  ConversationRecord,
  ConversationStore,
  ConversationTurnOptions,
  ConversationTurnResult,
  CreateConversationOptions,
  PersistedSession,
  ConversationSummary,
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
  id: string;
  backend: string;
  agentName: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  sessionPromise: Promise<AgentSession>;
  handle?: ConversationHandle;
  unsubscribe?: () => void;
  turnCounter: number;
  activeTurnId?: number;
  activeTurnInterrupted: boolean;
  activeText: string;
  activeFinalText: string;
  activeMessages: string[];
  activeDeltaTasks: Promise<void>[];
  activeMessageDelivery: Promise<void>;
  activeMessageDeliveryError?: Error;
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

/**
 * Applies a per-conversation model override. Returns the same object when there is
 * nothing to change so identity-based comparisons in tests stay stable.
 */
function withConversationModel(agent: AgentConfig, model: string | undefined): AgentConfig {
  if (!model || model === agent.model) {
    return agent;
  }
  return { ...agent, model };
}

function isConversationOwnedBy(
  conversation: PersistedSession,
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

function toPersistedHandle(conversation: PersistedSession): ConversationHandle {
  return {
    sessionId: conversation.sessionId,
    ...(conversation.resumeRef !== undefined ? { sessionFile: conversation.resumeRef } : {}),
  };
}

function toResume(conversation: PersistedSession): {
  sessionId: string;
  resumeRef?: string;
  systemPrompt?: string;
} {
  return {
    sessionId: conversation.sessionId,
    ...(conversation.resumeRef !== undefined ? { resumeRef: conversation.resumeRef } : {}),
    ...(conversation.systemPrompt !== undefined ? { systemPrompt: conversation.systemPrompt } : {}),
  };
}

function wireStreaming(entry: ConversationEntry, session: AgentSession): void {
  if (entry.unsubscribe) {
    return;
  }

  entry.unsubscribe = session.subscribe((event) => {
    if (entry.activeTurnId === undefined || entry.activeTurnInterrupted) {
      return;
    }

    if (event.type === 'text_delta') {
      entry.activeText += event.delta;
      const maybeTask = entry.activeOptions?.onTextDelta?.(event.delta);
      if (maybeTask) {
        entry.activeDeltaTasks.push(Promise.resolve(maybeTask));
      }
      return;
    }

    if (event.type === 'assistant_message') {
      entry.activeMessages.push(event.text);
      const onMessage = entry.activeOptions?.onMessage;
      if (onMessage) {
        enqueueDelivery(entry, () => onMessage(event.text));
      }
      return;
    }

    if (event.type === 'turn_end') {
      entry.activeFinalText = event.text;
      const onFinal = entry.activeOptions?.onFinal;
      if (onFinal) {
        enqueueDelivery(entry, () => onFinal(event.text));
      }
    }
  });
}

function enqueueDelivery(entry: ConversationEntry, deliver: () => void | Promise<void>): void {
  entry.activeMessageDelivery = entry.activeMessageDelivery
    .then(async () => {
      if (entry.activeMessageDeliveryError || entry.activeTurnInterrupted || entry.closed) {
        return;
      }
      await deliver();
    })
    .catch((error) => {
      entry.activeMessageDeliveryError = toError(error);
    });
}

async function runWorker(
  sessions: Map<string, ConversationEntry>,
  entry: ConversationEntry,
  persistConversation: (entry: ConversationEntry, session: AgentSession) => void,
): Promise<void> {
  entry.workerRunning = true;

  while (entry.pending && !entry.closed) {
    const req = entry.pending;
    entry.pending = undefined;

    const turnId = ++entry.turnCounter;
    entry.activeTurnId = turnId;
    entry.activeTurnInterrupted = false;
    entry.activeText = '';
    entry.activeFinalText = '';
    entry.activeMessages = [];
    entry.activeDeltaTasks = [];
    entry.activeMessageDelivery = Promise.resolve();
    entry.activeMessageDeliveryError = undefined;
    entry.activeOptions = req.options;

    try {
      const session = await entry.sessionPromise;
      wireStreaming(entry, session);

      await session.prompt(req.text);
      await Promise.all(entry.activeDeltaTasks);
      await entry.activeMessageDelivery;
      if (entry.activeMessageDeliveryError) {
        throw entry.activeMessageDeliveryError;
      }

      if (entry.activeTurnInterrupted || entry.activeTurnId !== turnId || entry.closed) {
        req.deferred.resolve({ kind: 'interrupted' });
      } else {
        const handle = toHandle(session);
        entry.handle = handle;
        persistConversation(entry, session);
        req.deferred.resolve({
          kind: 'ok',
          text: entry.activeFinalText || entry.activeText,
          messages: entry.activeMessages,
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
    sessions.delete(entry.id);
  }
}

export function createConversationManager(options: ConversationManagerOptions): ConversationManager {
  const createSession = options.createSession ?? createDefaultAgentSessionFactory;
  const agentBackend = createSession.backend;
  const store = options.store ?? createInMemoryConversationStore();
  const sessions = new Map<string, ConversationEntry>();

  function resolveAgent<T extends AgentConfig | undefined>(id: string, agent: T): T {
    return (agent ? (withConversationModel(agent, store.get(id)?.model) as T) : agent);
  }

  function getPersistedSession(
    id: string,
    agent?: AgentConfig,
  ): PersistedSession | undefined {
    const persisted = store.getSession(id, agentBackend);
    if (!persisted || !isConversationOwnedBy(persisted, agent, agentBackend)) {
      return undefined;
    }
    return persisted;
  }

  function persistConversation(entry: ConversationEntry, session: AgentSession): void {
    const handle = toHandle(session);
    if (!handle.sessionId || sessions.get(entry.id) !== entry) {
      return;
    }
    store.putSession(entry.id, {
      sessionId: handle.sessionId,
      backend: entry.backend,
      model: entry.model,
      agentName: entry.agentName,
      ...(handle.sessionFile !== undefined ? { resumeRef: handle.sessionFile } : {}),
      ...(session.systemPrompt !== undefined ? { systemPrompt: session.systemPrompt } : {}),
    });
    entry.updatedAt = Date.now();
  }

  async function getSession(entry: ConversationEntry): Promise<AgentSession> {
    const session = await entry.sessionPromise;
    wireStreaming(entry, session);
    return session;
  }

  const manager: ConversationManager = {
    create(createOptions) {
      return store.create(createOptions).id;
    },

    get(id) {
      return store.get(id);
    },

    find(link) {
      return store.findByLink(link)?.id;
    },

    ensure(link) {
      return store.findByLink(link)?.id ?? store.create({ link }).id;
    },

    link(id, link) {
      store.link(id, link);
    },

    setModel(id, model) {
      store.setModel(id, model);
    },

    async runTurn(id, rawAgent, text, turnOptions) {
      let entry = sessions.get(id);
      if (!entry) {
        const conversation = store.get(id);
        if (!conversation) {
          return { kind: 'error', error: new UnknownConversationError(id) };
        }
        // Resolved when the session opens so Slack turns, scheduled reminders,
        // and post-restart triggers all land on the conversation's chosen model.
        const agent = withConversationModel(rawAgent, conversation.model);
        const cwd = agent.cwd ?? options.defaultCwd;
        const persisted = getPersistedSession(id, agent);
        const now = Date.now();
        entry = {
          id,
          backend: agentBackend,
          agentName: agent.name,
          model: resolveAgentModel(agent),
          createdAt: now,
          updatedAt: now,
          sessionPromise: createSession({
            conversation: { id, links: conversation.links },
            agent,
            cwd,
            ...(persisted ? { resume: toResume(persisted) } : {}),
          }),
          ...(persisted ? { handle: toPersistedHandle(persisted) } : {}),
          turnCounter: 0,
          activeTurnInterrupted: false,
          activeText: '',
          activeFinalText: '',
          activeMessages: [],
          activeDeltaTasks: [],
          activeMessageDelivery: Promise.resolve(),
          workerRunning: false,
          closed: false,
        };
        sessions.set(id, entry);
      }

      const deferred = createDeferred<ConversationTurnResult>();
      entry.updatedAt = Date.now();

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

    has(id, rawAgent) {
      const agent = resolveAgent(id, rawAgent);
      const entry = sessions.get(id);
      if (entry) {
        return (
          !agent ||
          (entry.agentName === agent.name &&
            entry.model === resolveAgentModel(agent) &&
            entry.backend === agentBackend)
        );
      }
      return getPersistedSession(id, agent) !== undefined;
    },

    getHandle(id, rawAgent) {
      const agent = resolveAgent(id, rawAgent);
      const entry = sessions.get(id);
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

      const persisted = getPersistedSession(id, agent);
      return persisted ? toPersistedHandle(persisted) : undefined;
    },

    activeWorkCount() {
      let count = 0;
      for (const entry of sessions.values()) {
        if (entry.activeTurnId !== undefined || entry.pending) {
          count += 1;
        }
      }
      return count;
    },

    async list() {
      const persisted = new Map(
        store.listSessions(agentBackend).map((conversation) => [
          conversation.conversationId,
          conversation,
        ]),
      );
      const summaries = new Map<string, ConversationSummary>(persisted);

      await Promise.all(
        [...sessions.values()].map(async (entry) => {
          try {
            const session = await entry.sessionPromise;
            const stored = persisted.get(entry.id);
            if (entry.closed || sessions.get(entry.id) !== entry) return;
            summaries.set(entry.id, {
              conversationId: entry.id,
              links: stored?.links ?? store.get(entry.id)?.links ?? [],
              sessionId: session.sessionId,
              backend: entry.backend,
              model: entry.model,
              agentName: entry.agentName,
              createdAt: stored?.createdAt ?? entry.createdAt,
              updatedAt: Math.max(stored?.updatedAt ?? 0, entry.updatedAt),
            });
          } catch {
            // A session that failed before producing an identifier is not listable.
          }
        }),
      );

      // oxlint-disable-next-line unicorn/no-array-sort -- this sorts a fresh array copy.
      return [...summaries.values()].sort(
        (left, right) =>
          right.updatedAt - left.updatedAt || left.conversationId.localeCompare(right.conversationId),
      );
    },

    async close(id) {
      const entry = sessions.get(id);
      if (!entry) {
        return;
      }

      entry.closed = true;
      sessions.delete(id);
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

    async purge(id) {
      const existed = sessions.has(id) || getPersistedSession(id) !== undefined;
      const closing = manager.close(id);
      store.removeSession(id, agentBackend);
      await closing;
      return existed;
    },

    async closeAll() {
      const ids = [...sessions.keys()];
      await Promise.all(ids.map((id) => manager.close(id)));
    },
  };

  return manager;
}
