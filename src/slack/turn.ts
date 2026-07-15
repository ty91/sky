import { TranscriptWriter } from '../agents/memory/transcript.js';
import type { AgentConfig } from '../agents/types.js';
import type { ConversationManager } from '../conversation/manager.js';
import type { TurnActivityIndicator } from './activity-indicator.js';

export const SLACK_TURN_ERROR_REPLY = '오류가 났습니다. 잠시 뒤 다시 시도해 주세요.';

export type SlackTurnReplyAdapter = {
  sendReply(text: string): Promise<void>;
};

export type ExecuteSlackTurnOptions = {
  threadId: string;
  text: string;
  conversationManager: ConversationManager;
  mainAgent: AgentConfig;
  /** Shows the "thinking" state; hidden around each sent message. */
  indicator: TurnActivityIndicator;
  reply: SlackTurnReplyAdapter;
};

export async function executeSlackTurn({
  threadId,
  text,
  conversationManager,
  mainAgent,
  indicator,
  reply,
}: ExecuteSlackTurnOptions): Promise<void> {
  const transcript = new TranscriptWriter(threadId);

  await indicator.begin();

  try {
    transcript.appendUser(text);
    let finalSent = false;

    const result = await conversationManager.runTurn(threadId, mainAgent, text, {
      // Record every assistant message (interim + final) for memory, but do
      // not deliver interim messages to Slack.
      onMessage: (message) => {
        transcript.appendAssistant(message);
      },
      // Only the final message is delivered to Slack.
      onFinal: async (finalText) => {
        finalSent = true;
        await indicator.pause();
        await reply.sendReply(finalText);
        await indicator.begin();
      },
    });

    if (result.kind === 'interrupted') {
      return;
    }

    if (result.kind === 'error') {
      throw result.error;
    }

    transcript.setSessionId(result.handle.sessionId);

    // Fallback: if the run finished without a turn_end signal, still deliver
    // whatever final text the manager captured.
    if (!finalSent && result.text) {
      await indicator.pause();
      await reply.sendReply(result.text);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[slack] error handling turn in ${threadId}: ${message}`);
    await reply.sendReply(SLACK_TURN_ERROR_REPLY);
  } finally {
    await indicator.end();
  }
}
