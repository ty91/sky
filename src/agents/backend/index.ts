import { createPiSessionFactory } from './pi.js';
import type { AgentSessionFactory } from './types.js';

export const createDefaultAgentSessionFactory: AgentSessionFactory = createPiSessionFactory;
