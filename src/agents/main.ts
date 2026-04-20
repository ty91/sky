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
] as const;

export type MainAgentConfigOptions = {
  /** Baseline prompt; also used for resumed sessions that have no stored snapshot. */
  systemPrompt: string;
  /** Called on new sessions so AGENTS.md/MEMORY.md edits take effect without a bot restart. */
  systemPromptLoader?: () => string;
  model?: string;
};

export function createMainAgentConfig(options: MainAgentConfigOptions): AgentConfig {
  return {
    name: 'main',
    systemPrompt: options.systemPrompt,
    systemPromptLoader: options.systemPromptLoader,
    model: options.model ?? 'claude-opus-4-7',
    tools: [...MAIN_AGENT_TOOLS],
  };
}
