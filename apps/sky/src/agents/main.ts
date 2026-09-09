import type { AgentEffort } from './effort.js';
import type { AgentConfig, AgentToolSpecFactory } from './types.js';

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
  systemPrompt: string;
  systemPromptLoader?: () => string;
  model?: string;
  effort?: AgentEffort;
  customToolsFactory?: AgentToolSpecFactory;
  customToolNames?: string[];
};

export function createMainAgentConfig(options: MainAgentConfigOptions): AgentConfig {
  return {
    name: 'main',
    systemPrompt: options.systemPrompt,
    systemPromptLoader: options.systemPromptLoader,
    model: options.model ?? 'anthropic/claude-opus-4-7',
    ...(options.effort ? { effort: options.effort } : {}),
    tools: [...MAIN_AGENT_TOOLS, ...(options.customToolNames ?? [])],
    customToolsFactory: options.customToolsFactory,
  };
}
