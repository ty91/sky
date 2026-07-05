import type { AgentConfig } from '../agents/types.js';
import type { AgentSessionFactory } from '../agents/backend/types.js';

export type ConversationHandle = {
  sessionId: string;
  sessionFile?: string;
};

export type PersistedConversation = {
  sessionId: string;
  backend: string;
  model: string;
  agentName: string;
  resumeRef?: string;
};

export interface ConversationStore {
  get(key: string): PersistedConversation | undefined;
  put(key: string, conversation: PersistedConversation): void;
  remove(key: string): void;
  close(): void;
}

export type ConversationTurnResult =
  | { kind: 'ok'; text: string; handle: ConversationHandle }
  | { kind: 'interrupted' }
  | { kind: 'error'; error: Error };

export type ConversationTurnOptions = {
  onTextDelta?: (delta: string) => void | Promise<void>;
};

export type ConversationManagerOptions = {
  defaultCwd: string;
  createSession?: AgentSessionFactory;
  store?: ConversationStore;
};

export type ConversationManager = {
  runTurn(
    key: string,
    agent: AgentConfig,
    text: string,
    options?: ConversationTurnOptions,
  ): Promise<ConversationTurnResult>;
  has(key: string, agent?: AgentConfig): boolean;
  getHandle(key: string, agent?: AgentConfig): ConversationHandle | undefined;
  close(key: string): Promise<void>;
  purge(key: string): Promise<void>;
  closeAll(): Promise<void>;
};
