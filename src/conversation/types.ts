import type { AgentConfig } from '../agents/types.js';

export type ConversationHandle = {
  sessionId: string;
  sessionFile?: string;
};

export type PersistedConversation = {
  sessionId: string;
  sessionFile: string;
  model: string;
  agentName: string;
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

export type PiSessionEvent = {
  type: string;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
  };
};

export type PiAgentSession = {
  readonly sessionId: string;
  readonly sessionFile?: string;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
};

export type CreateConversationSessionOptions = {
  key: string;
  agent: AgentConfig;
  cwd: string;
  sessionFile?: string;
};

export type ConversationSessionFactory = (
  options: CreateConversationSessionOptions,
) => Promise<PiAgentSession>;

export type ConversationManagerOptions = {
  defaultCwd: string;
  createSession?: ConversationSessionFactory;
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
