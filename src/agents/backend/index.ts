import { createPiSessionFactory } from './pi.js';
import type { AgentBackend, AgentSessionFactory } from './types.js';

export const createDefaultAgentSessionFactory: AgentSessionFactory = createPiSessionFactory;

const createClaudeAgentSdkSessionFactory: AgentSessionFactory = Object.assign(
  async () => {
    throw new Error('Claude Agent SDK backend is not implemented yet. TY-6 will add it.');
  },
  { backend: 'claude-agent-sdk' as const },
);

export function resolveAgentSessionFactory(agentBackend: AgentBackend): AgentSessionFactory {
  switch (agentBackend) {
    case 'pi':
      return createPiSessionFactory;
    case 'claude-agent-sdk':
      return createClaudeAgentSdkSessionFactory;
  }
}
