import type { AgentConfig } from '../types.js';
import type { ZodRawShape } from 'zod';

export type AgentSessionEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'message_end' };

export type AgentSession = {
  readonly sessionId: string;
  readonly resumeRef?: string;
  readonly systemPrompt?: string;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
};

export type CreateAgentSessionOptions = {
  key: string;
  agent: AgentConfig;
  cwd: string;
  resume?: { sessionId: string; resumeRef?: string; systemPrompt?: string };
};

export type AgentBackend = 'pi' | 'claude-agent-sdk';

export type AgentSessionFactory = ((
  options: CreateAgentSessionOptions,
) => Promise<AgentSession>) & {
  readonly backend: AgentBackend;
};

export type AgentToolResult = {
  content: { type: 'text'; text: string }[];
  details?: unknown;
  isError?: boolean;
};

export type AgentToolSpec = {
  name: string;
  label?: string;
  description: string;
  inputSchema: ZodRawShape;
  execute(input: unknown): Promise<AgentToolResult>;
};
