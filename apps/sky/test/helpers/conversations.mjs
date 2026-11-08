import { createConversationManager } from '../../dist/conversation/manager.js';
import { openConversationStore } from '../../dist/conversation/store.js';

const SLACK = 'slack';

function okResult(reply) {
  return {
    kind: 'ok',
    text: reply,
    messages: reply ? [reply] : [],
    handle: { sessionId: 'pi-session-1', sessionFile: '/tmp/pi-session-1.jsonl' },
  };
}

export function createRecordingConversations({ reply = '응답', runTurnResult, runTurn } = {}) {
  const store = openConversationStore(':memory:');
  const real = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: Object.assign(
      async () => {
        throw new Error('Slack handler tests record turns without opening agent sessions.');
      },
      { backend: 'pi' },
    ),
  });
  const calls = { runTurn: [] };
  const threadOf = (id) => store.get(id)?.links.find((link) => link.provider === SLACK)?.externalId;

  return {
    calls,
    store,
    threadOf,
    manager: {
      ...real,
      runTurn: async (id, agent, text, options) => {
        const key = threadOf(id);
        calls.runTurn.push({ agent, key, text });
        if (runTurn) return runTurn(key, agent, text, options);
        if (reply && options?.onTextDelta) await options.onTextDelta(reply);
        return runTurnResult ?? okResult(reply);
      },
    },
    startThread(threadKey, agent) {
      const conversation = store.create({ link: { provider: SLACK, externalId: threadKey } });
      store.putSession(conversation.id, {
        sessionId: 'pi-session-existing',
        backend: 'pi',
        model: agent.model ?? '',
        agentName: agent.name,
      });
      return conversation.id;
    },
    modelOf(threadKey) {
      return store.findByLink({ provider: SLACK, externalId: threadKey })?.model;
    },
  };
}
