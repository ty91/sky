import type { AgentConfig } from '../agents/types.js';
import type { CollectOptions, ProviderFactory, ProviderSession } from '../providers/types.js';

export type SessionEntry = {
  provider: ProviderSession;
  busy: boolean;
  sessionId?: string;
};

export type SendResult =
  | { kind: 'ok'; text: string }
  | { kind: 'busy' }
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
