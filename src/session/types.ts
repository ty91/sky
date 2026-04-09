import type { AgentConfig } from '../agents/types.js';
import type { CollectOptions, ProviderFactory, ProviderSession } from '../providers/types.js';

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
  onSessionCreated?: (key: string, sessionId: string) => void;
};

export type OpenSessionOptions = {
  resume?: string;
};

export type SessionManager = {
  open(key: string, agent: AgentConfig, options?: OpenSessionOptions): void;
  send(key: string, text: string, options?: CollectOptions): Promise<SendResult>;
  getSessionId(key: string): string | undefined;
  close(key: string): Promise<void>;
  closeAll(): Promise<void>;
};
