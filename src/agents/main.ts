import {
  createRestartHarnessServer,
  RESTART_HARNESS_FQ_TOOL_NAME,
  RESTART_HARNESS_SERVER_NAME,
} from './tools/restart-harness.js';
import type { AgentConfig, McpFactoryContext } from './types.js';

const MAIN_AGENT_TOOLS = [
  'Bash',
  'Glob',
  'Grep',
  'Read',
  'Edit',
  'Write',
  'Skill',
  'TaskOutput',
  'TaskStop',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  RESTART_HARNESS_FQ_TOOL_NAME,
] as const;

export type MainAgentConfigOptions = {
  /** Baseline prompt; also used for resumed sessions that have no stored snapshot. */
  systemPrompt: string;
  /** Called on new sessions so AGENTS.md/MEMORY.md edits take effect without a bot restart. */
  systemPromptLoader?: () => string;
  /**
   * Called when Sky invokes `restart_harness` and the request is accepted.
   * The bot uses this to schedule the actual process swap (detached spawn +
   * SIGTERM) on a short delay so the current assistant turn can flush first.
   */
  onRestartRequested?: (ctx: McpFactoryContext) => void;
  model?: string;
};

function parseSessionKey(sessionKey: string): { channelId: string; threadTs: string } {
  // Slack session keys are `<channelId>:<threadTs>` per `slack/assistant.ts`.
  // Fall back to the whole string as channelId if the format ever changes so
  // downstream doesn't crash — the restart will still record but the
  // post-restart trigger won't have a valid thread to reply into.
  const idx = sessionKey.indexOf(':');
  if (idx === -1) return { channelId: sessionKey, threadTs: '' };
  return {
    channelId: sessionKey.slice(0, idx),
    threadTs: sessionKey.slice(idx + 1),
  };
}

export function createMainAgentConfig(options: MainAgentConfigOptions): AgentConfig {
  return {
    name: 'main',
    systemPrompt: options.systemPrompt,
    systemPromptLoader: options.systemPromptLoader,
    model: options.model ?? 'anthropic/claude-opus-4-7',
    tools: [...MAIN_AGENT_TOOLS],
    mcpServersFactory: ({ sessionKey }) => {
      const { channelId, threadTs } = parseSessionKey(sessionKey);
      return {
        [RESTART_HARNESS_SERVER_NAME]: createRestartHarnessServer({
          sessionKey,
          channelId,
          threadTs,
          scheduleRestart: () => options.onRestartRequested?.({ sessionKey }),
        }),
      };
    },
  };
}
