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
  model?: string;
  tools?: string[];
  maxTurns?: number;
  cwd?: string;
};
