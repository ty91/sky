import type { AgentToolSpec } from './backend/types.js';

/**
 * Context handed to per-session tool factories when a session opens. Lets
 * bound tools (e.g. `restart_harness`) know which thread they're acting on.
 */
export type McpFactoryContext = {
  sessionKey: string;
};

export type AgentToolSpecFactory = (ctx: McpFactoryContext) => AgentToolSpec[];

export type AgentConfig = {
  name: string;
  description?: string;
  /**
   * Baseline system prompt. Used directly when no `systemPromptLoader`
   * is provided, and as a fallback when a resumed session has no stored
   * prompt snapshot (legacy records).
   */
  systemPrompt: string;
  /**
   * Optional function for loading the current system prompt from disk.
   * Pi stores the prompt snapshot in its session file, so resumed Pi sessions
   * skip this loader. Claude Agent SDK resume does not persist the system
   * prompt, so the loader runs on every turn.
   */
  systemPromptLoader?: () => string;
  /** Optional factory for per-session custom tools. */
  customToolsFactory?: AgentToolSpecFactory;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  cwd?: string;
};
