export type AgentConfig = {
  name: string;
  description?: string;
  systemPrompt: string;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  cwd?: string;
};
