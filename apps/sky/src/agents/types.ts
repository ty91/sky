import type { AgentToolSpec } from './backend/types.js';
import type { AgentEffort } from './effort.js';

/**
 * Context handed to per-session tool factories when a session opens. Lets
 * bound tools know which Slack thread they're acting on.
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
   * skip this loader. Claude Agent SDK stores the prompt snapshot in Sky's
   * conversation record and reuses it for resumed sessions.
   */
  systemPromptLoader?: () => string;
  /** Optional factory for per-session custom tools. */
  customToolsFactory?: AgentToolSpecFactory;
  model?: string;
  effort?: AgentEffort;
  tools?: string[];
  maxTurns?: number;
  cwd?: string;
};
