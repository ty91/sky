import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager as PiSessionManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from '../agents/types.js';
import type {
  ConversationHandle,
  ConversationManager,
  ConversationManagerOptions,
  ConversationSessionFactory,
  ConversationTurnOptions,
  ConversationTurnResult,
  PersistedConversation,
  PiAgentSession,
  PiSessionEvent,
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
  agentName: string;
  model: string;
  sessionPromise: Promise<PiAgentSession>;
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
): boolean {
  if (!agent) {
    return true;
  }
  return conversation.agentName === agent.name && conversation.model === resolveAgentModel(agent);
}

function toHandle(session: PiAgentSession): ConversationHandle {
  return {
    sessionId: session.sessionId,
    ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
  };
}

function extractTextDelta(event: PiSessionEvent): string | undefined {
  if (event.type !== 'message_update') {
    return undefined;
  }
  const assistantEvent = event.assistantMessageEvent;
  if (assistantEvent?.type !== 'text_delta' || typeof assistantEvent.delta !== 'string') {
    return undefined;
  }
  return assistantEvent.delta;
}

function wireStreaming(entry: ConversationEntry, session: PiAgentSession): void {
  if (entry.unsubscribe) {
    return;
  }

  entry.unsubscribe = session.subscribe((event) => {
    const delta = extractTextDelta(event);
    if (delta === undefined || entry.activeTurnId === undefined || entry.activeTurnInterrupted) {
      return;
    }

    entry.activeText += delta;
    const maybeTask = entry.activeOptions?.onTextDelta?.(delta);
    if (maybeTask) {
      entry.activeDeltaTasks.push(Promise.resolve(maybeTask));
    }
  });
}

function resolveModel(modelRegistry: ModelRegistry, modelName: string) {
  const slash = modelName.indexOf('/');
  if (slash <= 0 || slash === modelName.length - 1) {
    throw new Error(`Invalid Pi model name: ${modelName}`);
  }

  const provider = modelName.slice(0, slash);
  const modelId = modelName.slice(slash + 1);
  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`Pi model not found: ${modelName}`);
  }
  return model;
}

function resolveSystemPrompt(agent: AgentConfig): string {
  return agent.systemPromptLoader ? agent.systemPromptLoader() : agent.systemPrompt;
}

function toPiToolNames(tools: string[] | undefined): string[] | undefined {
  if (!tools) {
    return undefined;
  }

  const names = tools.map((tool) => {
    switch (tool) {
      case 'Bash':
        return 'bash';
      case 'Edit':
        return 'edit';
      case 'Find':
      case 'Glob':
        return 'find';
      case 'Grep':
        return 'grep';
      case 'Ls':
        return 'ls';
      case 'Read':
        return 'read';
      case 'Write':
        return 'write';
      default:
        return tool;
    }
  });
  return [...new Set(names)];
}

export const createDefaultPiSession: ConversationSessionFactory = async ({ key, agent, cwd, sessionFile }) => {
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = agent.model ? resolveModel(modelRegistry, agent.model) : undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPrompt: resolveSystemPrompt(agent),
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const customTools = agent.customToolsFactory?.({ sessionKey: key });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    ...(model ? { model } : {}),
    ...(agent.tools ? { tools: toPiToolNames(agent.tools) } : {}),
    ...(customTools ? { customTools } : {}),
    resourceLoader,
    sessionManager: sessionFile
      ? PiSessionManager.open(sessionFile, undefined, cwd)
      : PiSessionManager.create(cwd),
  });
  return session;
};

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
  const createSession = options.createSession ?? createDefaultPiSession;
  const sessions = new Map<string, ConversationEntry>();

  function getPersistedConversation(
    key: string,
    agent?: AgentConfig,
  ): PersistedConversation | undefined {
    const persisted = options.store?.get(key);
    if (!persisted || !isConversationOwnedBy(persisted, agent)) {
      return undefined;
    }
    return persisted;
  }

  function persistConversation(entry: ConversationEntry, handle: ConversationHandle): void {
    if (!handle.sessionFile || sessions.get(entry.key) !== entry) {
      return;
    }
    options.store?.put(entry.key, {
      sessionId: handle.sessionId,
      sessionFile: handle.sessionFile,
      model: entry.model,
      agentName: entry.agentName,
    });
  }

  async function getSession(entry: ConversationEntry): Promise<PiAgentSession> {
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
          agentName: agent.name,
          model: resolveAgentModel(agent),
          sessionPromise: createSession({
            key,
            agent,
            cwd,
            ...(persisted ? { sessionFile: persisted.sessionFile } : {}),
          }) as Promise<PiAgentSession>,
          ...(persisted
            ? { handle: { sessionId: persisted.sessionId, sessionFile: persisted.sessionFile } }
            : {}),
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
        return !agent || (entry.agentName === agent.name && entry.model === resolveAgentModel(agent));
      }
      return getPersistedConversation(key, agent) !== undefined;
    },

    getHandle(key, agent) {
      const entry = sessions.get(key);
      if (entry) {
        if (agent && (entry.agentName !== agent.name || entry.model !== resolveAgentModel(agent))) {
          return undefined;
        }
        return entry.handle;
      }

      const persisted = getPersistedConversation(key, agent);
      return persisted
        ? { sessionId: persisted.sessionId, sessionFile: persisted.sessionFile }
        : undefined;
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
      options.store?.remove(key);
    },

    async closeAll() {
      const keys = [...sessions.keys()];
      await Promise.all(keys.map((key) => manager.close(key)));
    },
  };

  return manager;
}

