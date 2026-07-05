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
   * Optional function invoked for **new** Pi sessions.
   * Lets the prompt be re-read from disk (e.g. AGENTS.md/MEMORY.md) so that
   * edits apply without restarting the bot process. Resumed sessions skip the
   * loader and continue from the Pi session file.
   */
  systemPromptLoader?: () => string;
  /** Optional factory for per-session custom tools. */
  customToolsFactory?: AgentToolSpecFactory;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  cwd?: string;
};
