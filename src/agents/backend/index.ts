import { createClaudeAgentSdkSessionFactory } from './claude.js';
import { createPiSessionFactory } from './pi.js';
import type { AgentBackend, AgentSessionFactory } from './types.js';

export const createDefaultAgentSessionFactory: AgentSessionFactory = createPiSessionFactory;

export type ResolveAgentSessionFactoryOptions = {
  /** OAuth token from settings.json, used as a fallback when no env var is set. */
  claudeCodeOauthToken?: string;
};

export function resolveAgentSessionFactory(
  agentBackend: AgentBackend,
  options: ResolveAgentSessionFactoryOptions = {},
): AgentSessionFactory {
  switch (agentBackend) {
    case 'pi':
      return createPiSessionFactory;
    case 'claude-agent-sdk': {
      // Precedence: an explicit CLAUDE_CODE_OAUTH_TOKEN env var wins (interactive
      // shells / ad-hoc overrides); otherwise fall back to the token from
      // settings.json so headless cron runs — which don't source ~/.zshrc — can
      // still authenticate. When neither is present we pass no env override and
      // the backend throws its helpful "token required" error at session start.
      const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? options.claudeCodeOauthToken;
      return createClaudeAgentSdkSessionFactory(
        token ? { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token } } : {},
      );
    }
  }
}
