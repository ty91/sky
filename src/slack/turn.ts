import { TranscriptWriter } from '../agents/memory/transcript.js';
import type { AgentConfig } from '../agents/types.js';
import type { ConversationManager } from '../conversation/manager.js';
import type { TurnActivityIndicator } from './activity-indicator.js';
import { addReaction, type ReactionsClient } from './reactions.js';

export const SLACK_TURN_ERROR_REPLY = '오류가 났습니다. 잠시 뒤 다시 시도해 주세요.';

export type SlackTurnReplyAdapter = {
  sendReply(text: string): Promise<void>;
};

export type ExecuteSlackTurnOptions = {
  threadId: string;
  channelId: string;
  messageTs: string;
  text: string;
  conversationManager: ConversationManager;
  mainAgent: AgentConfig;
  /** Shows the "thinking" state; hidden around each sent message. */
  indicator: TurnActivityIndicator;
  /** Used only for the `hand` marker on interrupted turns. */
  reactionClient: ReactionsClient;
  reply: SlackTurnReplyAdapter;
};

export async function executeSlackTurn({
  threadId,
  channelId,
  messageTs,
  text,
  conversationManager,
  mainAgent,
  indicator,
  reactionClient,
  reply,
}: ExecuteSlackTurnOptions): Promise<void> {
  const transcript = new TranscriptWriter(threadId);

  await indicator.begin();

  try {
    transcript.appendUser(text);
    let streamedText = '';
    const sentMessages: string[] = [];

    const result = await conversationManager.runTurn(threadId, mainAgent, text, {
      onTextDelta: (delta) => {
        streamedText += delta;
      },
      onMessage: async (message) => {
        await indicator.pause();
        sentMessages.push(message);
        transcript.appendAssistant(message);
        await reply.sendReply(message);
        // Resume the indicator in case this isn't the final message.
        await indicator.begin();
      },
    });

    if (result.kind === 'interrupted') {
      await addReaction(reactionClient, channelId, messageTs, 'hand');
      return;
    }

    if (result.kind === 'error') {
      throw result.error;
    }

    const assistantText = result.text || streamedText;
    const assistantMessages = result.messages.length > 0 ? result.messages : [assistantText];
    transcript.setSessionId(result.handle.sessionId);
    if (sentMessages.length > 0) {
      return;
    }
    await indicator.pause();
    for (const message of assistantMessages) {
      transcript.appendAssistant(message);
      await reply.sendReply(message);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[slack] error handling turn in ${threadId}: ${message}`);
    await reply.sendReply(SLACK_TURN_ERROR_REPLY);
  } finally {
    await indicator.end();
  }
}
