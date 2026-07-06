import { createDefaultClaudeAgentSdkSessionFactory } from './claude.js';
import { createPiSessionFactory } from './pi.js';
import type { AgentBackend, AgentSessionFactory } from './types.js';

export const createDefaultAgentSessionFactory: AgentSessionFactory = createPiSessionFactory;

export function resolveAgentSessionFactory(agentBackend: AgentBackend): AgentSessionFactory {
  switch (agentBackend) {
    case 'pi':
      return createPiSessionFactory;
    case 'claude-agent-sdk':
      return createDefaultClaudeAgentSdkSessionFactory;
  }
}
