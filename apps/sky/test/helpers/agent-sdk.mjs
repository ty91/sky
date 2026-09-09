import { createClaudeAgentSdkSessionFactory } from '../../dist/agents/backend/claude.js';

export function createAgentSdk({ beforePrompt = async () => {}, prompts = [] } = {}) {
  let nextId = 0;
  const turns = new Map();
  return createClaudeAgentSdkSessionFactory({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth' },
    query({ prompt, options }) {
      const sessionId = options.resume ?? `sdk-session-${++nextId}`;
      const iterator = (async function* () {
        const input = await prompt[Symbol.asyncIterator]().next();
        prompts.push(input.value.message.content);
        await beforePrompt();
        const turn = (turns.get(sessionId) ?? 0) + 1;
        turns.set(sessionId, turn);
        const tools = (options.allowedTools ?? [])
          .filter((name) => name.startsWith('mcp__sky__'))
          .map((name) => name.slice('mcp__sky__'.length));
        const result = `${turn}:${tools.join(',')}`;
        yield { type: 'system', subtype: 'init', session_id: sessionId, tools: [], mcp_servers: [] };
        yield { type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { content: [{ type: 'text', text: result }] } };
        yield { type: 'result', subtype: 'success', session_id: sessionId, is_error: false, result };
      })();
      return Object.assign(iterator, { async interrupt() {}, close() {} });
    },
  });
}
