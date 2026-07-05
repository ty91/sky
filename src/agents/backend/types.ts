import type { AgentConfig } from '../types.js';

export type AgentSessionEvent = { type: 'text_delta'; delta: string };

export type AgentSession = {
  readonly sessionId: string;
  readonly resumeRef?: string;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
};

export type CreateAgentSessionOptions = {
  key: string;
  agent: AgentConfig;
  cwd: string;
  resume?: { sessionId: string; resumeRef?: string };
};

export type AgentSessionFactory = (options: CreateAgentSessionOptions) => Promise<AgentSession>;
