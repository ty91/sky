import { createConversationManager } from '../../dist/conversation/manager.js';
import { openConversationStore } from '../../dist/conversation/store.js';

export function createSchedulerConversationManager({ finalText, error, store = openConversationStore(':memory:') } = {}) {
  const prompts = [];
  const sessions = [];
  const createSession = Object.assign(
    async (config) => {
      sessions.push(config);
      let listener;
      return {
        sessionId: 'scheduled-session',
        async prompt(text) {
          prompts.push(text);
          const failure = typeof error === 'function' ? error(prompts.length) : error;
          if (failure) {
            throw failure;
          }
          listener?.({ type: 'assistant_message', text: finalText });
          listener?.({ type: 'turn_end', text: finalText });
        },
        async abort() {},
        dispose() {},
        subscribe(nextListener) {
          listener = nextListener;
          return () => {
            listener = undefined;
          };
        },
      };
    },
    { backend: 'pi' },
  );

  return {
    manager: createConversationManager({ defaultCwd: '/tmp', createSession, store }),
    prompts,
    sessions,
    store,
  };
}
