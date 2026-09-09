import { createConversationManager } from '../../dist/conversation/manager.js';

export function createSchedulerConversationManager({ finalText, error } = {}) {
  const prompts = [];
  const createSession = Object.assign(
    async () => {
      let listener;
      return {
        sessionId: 'scheduled-session',
        async prompt(text) {
          prompts.push(text);
          if (error) {
            throw error;
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
    manager: createConversationManager({ defaultCwd: '/tmp', createSession }),
    prompts,
  };
}
