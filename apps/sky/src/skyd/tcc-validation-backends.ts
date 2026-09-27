import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createPiSessionFactoryWithDeps } from '../agents/backend/pi.js';
import { createClaudeAgentSdkSessionFactory } from '../agents/backend/claude.js';
import type { AgentSessionFactory } from '../agents/backend/types.js';
import type { Settings } from '../settings.js';

export function createObservedValidationBackend(
  settings: Settings,
  record: (event: unknown) => void,
): AgentSessionFactory {
  if (settings.agentBackend === 'pi') {
    return createPiSessionFactoryWithDeps({
      DefaultResourceLoader,
      getAgentDir,
      ModelRuntime,
      SessionManager,
      createAgentSession: async (options) => {
        const created = await createAgentSession(options);
        created.session.subscribe((event) => {
          if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
            record(event);
          }
        });
        return created;
      },
    });
  }

  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? settings.claudeAgentSdk?.oauthToken;
  return createClaudeAgentSdkSessionFactory({
    ...(token ? { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token } } : {}),
    query: (options) => {
      const result = query(options);
      const iterate = result[Symbol.asyncIterator].bind(result);
      result[Symbol.asyncIterator] = async function* () {
        for await (const message of { [Symbol.asyncIterator]: iterate }) {
          if (message.type === 'assistant' || message.type === 'user') {
            const content = message.message.content;
            if (Array.isArray(content)) {
              const blocks = content.filter((block) =>
                block.type === 'tool_use' || block.type === 'tool_result');
              if (blocks.length > 0) record({ type: message.type, content: blocks });
            }
          }
          yield message;
        }
      };
      return result;
    },
  });
}
