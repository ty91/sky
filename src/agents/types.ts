import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ProviderMcpServerConfig } from '../providers/types.js';

/**
 * Context handed to per-session tool factories when a session opens. Lets
 * bound tools (e.g. `restart_harness`) know which thread they're acting on.
 */
export type McpFactoryContext = {
  sessionKey: string;
};

export type McpServersFactory = (ctx: McpFactoryContext) => Record<string, ProviderMcpServerConfig>;
export type PiCustomToolsFactory = (ctx: McpFactoryContext) => ToolDefinition<any, any, any>[];

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
   * Optional function invoked at `SessionManager.open()` for **new** sessions.
   * Lets the prompt be re-read from disk (e.g. AGENTS.md/MEMORY.md) so that
   * edits apply without restarting the bot process. Resumed sessions skip the
   * loader and reuse the snapshot stored alongside their session id to keep
   * Anthropic prompt caching intact.
   */
  systemPromptLoader?: () => string;
  /**
   * Optional factory for per-session MCP servers. Invoked every time the
   * session manager opens a session so each session can receive its own bound
   * tools or stdio/http/sse server config.
   */
  mcpServersFactory?: McpServersFactory;
  /** Optional factory for per-session Pi custom tools. */
  customToolsFactory?: PiCustomToolsFactory;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  cwd?: string;
};
