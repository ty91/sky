import type { AgentConfig } from '../agents/types.js';
import type {
  ConversationManager,
  ConversationTurnResult,
} from '../conversation/manager.js';

export type ProactiveAgentTurnOptions = {
  conversationManager: Pick<ConversationManager, 'runTurn'>;
  mainAgent: AgentConfig;
  sessionKey: string;
  prompt: string;
  deliverFinal(text: string): Promise<void>;
};

export async function runProactiveAgentTurn(
  options: ProactiveAgentTurnOptions,
): Promise<ConversationTurnResult> {
  let finalDelivered = false;
  const result = await options.conversationManager.runTurn(
    options.sessionKey,
    options.mainAgent,
    options.prompt,
    {
      onFinal: async (text) => {
        finalDelivered = true;
        await options.deliverFinal(text);
      },
    },
  );

  if (result.kind === 'ok' && !finalDelivered && result.text) {
    await options.deliverFinal(result.text);
  }

  return result;
}
