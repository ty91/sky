import type { AgentConfig } from '../agents/types.js';
import type { AgentSessionFactory } from '../agents/backend/types.js';

export type ConversationLink = {
  provider: string;
  externalId: string;
};

export type ConversationRecord = {
  id: string;
  model?: string;
  links: ConversationLink[];
  createdAt: number;
  updatedAt: number;
};

export type CreateConversationOptions = {
  id?: string;
  model?: string;
  link?: ConversationLink;
};

export type ConversationHandle = {
  sessionId: string;
  sessionFile?: string;
};

export type PersistedSession = {
  sessionId: string;
  backend: string;
  model: string;
  agentName: string;
  resumeRef?: string;
  systemPrompt?: string;
};

export type ConversationSummary = PersistedSession & {
  conversationId: string;
  links: ConversationLink[];
  createdAt: number;
  updatedAt: number;
};

export interface ConversationStore {
  create(options?: CreateConversationOptions): ConversationRecord;
  get(id: string): ConversationRecord | undefined;
  findByLink(link: ConversationLink): ConversationRecord | undefined;
  link(id: string, link: ConversationLink): void;
  setModel(id: string, model: string): void;
  getSession(id: string, backend: string): PersistedSession | undefined;
  putSession(id: string, session: PersistedSession): void;
  removeSession(id: string, backend: string): void;
  listSessions(backend: string): ConversationSummary[];
  close(): void;
}

export type ConversationTurnResult =
  | { kind: 'ok'; text: string; messages: string[]; handle: ConversationHandle }
  | { kind: 'interrupted' }
  | { kind: 'error'; error: Error };

export type ConversationTurnOptions = {
  onTextDelta?: (delta: string) => void | Promise<void>;
  /** Fired for every completed assistant message (interim + final). */
  onMessage?: (message: string) => void | Promise<void>;
  /** Fired once with the final answer when the turn completes. */
  onFinal?: (text: string) => void | Promise<void>;
};

export type ConversationManagerOptions = {
  defaultCwd: string;
  createSession?: AgentSessionFactory;
  store?: ConversationStore;
};

export type ConversationManager = {
  create(options?: CreateConversationOptions): string;
  get(id: string): ConversationRecord | undefined;
  find(link: ConversationLink): string | undefined;
  ensure(link: ConversationLink): string;
  link(id: string, link: ConversationLink): void;
  setModel(id: string, model: string): void;
  runTurn(
    id: string,
    agent: AgentConfig,
    text: string,
    options?: ConversationTurnOptions,
  ): Promise<ConversationTurnResult>;
  has(id: string, agent?: AgentConfig): boolean;
  getHandle(id: string, agent?: AgentConfig): ConversationHandle | undefined;
  activeWorkCount(): number;
  list(): Promise<ConversationSummary[]>;
  close(id: string): Promise<void>;
  purge(id: string): Promise<boolean>;
  closeAll(): Promise<void>;
};
