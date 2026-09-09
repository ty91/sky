export const AGENT_EFFORT_LEVELS = ['medium', 'high', 'xhigh'] as const;

export type AgentEffort = (typeof AGENT_EFFORT_LEVELS)[number];
