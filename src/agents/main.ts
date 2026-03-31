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

export function createMainAgentConfig(systemPrompt: string): AgentConfig {
  return {
    name: 'main',
    systemPrompt,
    model: 'sonnet',
    tools: [...MAIN_AGENT_TOOLS],
  };
}
