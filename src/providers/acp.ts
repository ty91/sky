import { createClaudeProviderFactory } from './claude.js';
import type { ProviderFactory } from './types.js';

type AcpProviderDefaults = {
  cwd: string;
};

export function createAcpProviderFactory(defaults: AcpProviderDefaults): ProviderFactory {
  return createClaudeProviderFactory(defaults);
}
