import type { AgentConfig } from '../types.js';
import type { ZodRawShape } from 'zod';

export type AgentSessionEvent =
  // Token-level streaming of the in-progress assistant message.
  | { type: 'text_delta'; delta: string }
  // A completed assistant message block. Emitted once per assistant message
  // and may be an interim message (the agent will continue, e.g. before a
  // tool call) or the last one of the run.
  | { type: 'assistant_message'; text: string }
  // The prompt() run has completed. `text` is the final/definitive answer and
  // equals the text of the last `assistant_message`. Fires exactly once per run.
  | { type: 'turn_end'; text: string };

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
