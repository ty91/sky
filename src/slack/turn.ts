import { TranscriptWriter } from '../agents/memory/transcript.js';
import type { AgentConfig } from '../agents/types.js';
import type { ConversationManager } from '../conversation/manager.js';
import { addReaction, removeReaction, type ReactionsClient } from './reactions.js';

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
  reactionClient,
  reply,
}: ExecuteSlackTurnOptions): Promise<void> {
  const transcript = new TranscriptWriter(threadId);

  await addReaction(reactionClient, channelId, messageTs, 'thought_balloon');

  try {
    transcript.appendUser(text);
    let streamedText = '';

    const result = await conversationManager.runTurn(threadId, mainAgent, text, {
      onTextDelta: (delta) => {
        streamedText += delta;
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
    for (const message of assistantMessages) {
      transcript.appendAssistant(message);
      await reply.sendReply(message);
    }
    await addReaction(reactionClient, channelId, messageTs, 'white_check_mark');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[slack] error handling turn in ${threadId}: ${message}`);
    await reply.sendReply(SLACK_TURN_ERROR_REPLY);
  } finally {
    await removeReaction(reactionClient, channelId, messageTs, 'thought_balloon');
  }
}
