import type { AgentConfig } from '../agents/types.js';
import type { CollectOptions, ProviderFactory, ProviderSession } from '../providers/types.js';
import type { SessionStore } from './store.js';

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

export type PendingRequest = {
  text: string;
  collectOptions?: CollectOptions;
  deferred: Deferred<SendResult>;
};

export type SessionEntry = {
  provider: ProviderSession;
  agent: AgentConfig;
  sessionId?: string;
  turnCounter: number;
  activeTurnId?: number;
  activeTurnInterrupted: boolean;
  pending?: PendingRequest;
  workerRunning: boolean;
  closed: boolean;
};

export type SendResult =
  | { kind: 'ok'; text: string }
  | { kind: 'interrupted' }
  | { kind: 'error'; error: Error };

export type SessionManagerOptions = {
  providerFactory: ProviderFactory;
  defaultCwd: string;
  /**
   * Optional persistent store for session ids (and, later, frozen system
   * prompts). When provided the manager automatically resumes on `open()` and
   * writes new session ids after the first turn completes.
   *
   * Omit the store for ephemeral managers such as the Memory Agent runner.
   */
  store?: SessionStore;
};

export type SessionManager = {
  /**
   * Register a session for `key`. Idempotent: calling `open` again for an
   * already-open key is a no-op. If a store is configured and has a record
   * for this key, the underlying provider resumes automatically.
   */
  open(key: string, agent: AgentConfig): void;
  send(key: string, text: string, options?: CollectOptions): Promise<SendResult>;
  getSessionId(key: string): string | undefined;
  /** Terminate the in-memory session; keeps any persisted record for later resume. */
  close(key: string): Promise<void>;
  /** Terminate the in-memory session *and* delete the persisted record. */
  purge(key: string): Promise<void>;
  closeAll(): Promise<void>;
};
