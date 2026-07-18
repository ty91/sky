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
  systemPrompt?: string;
};

export interface ConversationStore {
  get(key: string, backend: string): PersistedConversation | undefined;
  put(key: string, conversation: PersistedConversation): void;
  remove(key: string, backend: string): void;
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
  runTurn(
    key: string,
    agent: AgentConfig,
    text: string,
    options?: ConversationTurnOptions,
  ): Promise<ConversationTurnResult>;
  has(key: string, agent?: AgentConfig): boolean;
  getHandle(key: string, agent?: AgentConfig): ConversationHandle | undefined;
  /**
   * Move an existing conversation from `oldKey` to `newKey` without touching the
   * underlying backend session (history lives in the backend, keyed by
   * `sessionId`/`resumeRef`). Only the in-memory index and the persisted store
   * pointer are relocated. Intended to be called while the conversation is idle
   * (no active or pending turn), e.g. right after a proactive scheduler turn so
   * the user's reply thread resumes the same session. No-op when `oldKey` has no
   * session or when the keys are equal.
   */
  rekey(oldKey: string, newKey: string): void;
  close(key: string): Promise<void>;
  purge(key: string): Promise<void>;
  closeAll(): Promise<void>;
};
