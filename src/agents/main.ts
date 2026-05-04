import { fileURLToPath } from 'node:url';
import {
  RESTART_HARNESS_FQ_TOOL_NAME,
  RESTART_HARNESS_SERVER_NAME,
} from './tools/restart-harness.js';
import type { AgentConfig } from './types.js';

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
  model?: string;
};

function restartHarnessServerPath(): string {
  return fileURLToPath(new URL('../mcp/restart-harness-server.js', import.meta.url));
}

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
        [RESTART_HARNESS_SERVER_NAME]: {
          name: RESTART_HARNESS_SERVER_NAME,
          command: process.execPath,
          args: [restartHarnessServerPath()],
          env: [
            { name: 'SKY_SESSION_KEY', value: sessionKey },
            { name: 'SKY_SLACK_CHANNEL_ID', value: channelId },
            { name: 'SKY_SLACK_THREAD_TS', value: threadTs },
            { name: 'SKY_PARENT_PID', value: String(process.pid) },
          ],
        },
      };
    },
  };
}
