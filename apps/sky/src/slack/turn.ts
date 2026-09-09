import { TranscriptWriter } from '../agents/memory/transcript.js';
import type { AgentConfig } from '../agents/types.js';
import type { ConversationManager } from '../conversation/manager.js';
import type { TurnActivityIndicator } from './activity-indicator.js';
import type { RuntimeController } from '../runtime/controller.js';
import { createSkyHome, type SkyHome } from '../sky-home.js';

export const SLACK_TURN_ERROR_REPLY = '오류가 났습니다. 잠시 뒤 다시 시도해 주세요.';
export const SLACK_DRAINING_REPLY = 'Sky가 재시작을 준비 중입니다. 잠시 뒤 다시 시도해 주세요.';

const INTERIM_LOG_PREVIEW_LENGTH = 100;

function previewForLog(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > INTERIM_LOG_PREVIEW_LENGTH
    ? `${collapsed.slice(0, INTERIM_LOG_PREVIEW_LENGTH)}…`
    : collapsed;
}

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
  runtimeController?: Pick<RuntimeController, 'lease'>;
  skyHome?: SkyHome;
};

export async function executeSlackTurn({
  threadId,
  text,
  conversationManager,
  mainAgent,
  indicator,
  reply,
  runtimeController,
  skyHome = createSkyHome(),
}: ExecuteSlackTurnOptions): Promise<void> {
  const lease = runtimeController?.lease('slack_turn');
  if (runtimeController && !lease) {
    await reply.sendReply(SLACK_DRAINING_REPLY);
    return;
  }
  const transcript = new TranscriptWriter(threadId, skyHome);

  try {
    await indicator.begin();
    transcript.appendUser(text);
    let finalSent = false;
    // Holds the most recent assistant message. Once another message arrives it
    // is confirmed to be an interim message and gets logged; the last message
    // of the turn is the final one and is never logged here.
    let pendingInterim: string | undefined;

    const result = await conversationManager.runTurn(threadId, mainAgent, text, {
      // Record every assistant message (interim + final) for memory, but do
      // not deliver interim messages to Slack.
      onMessage: (message) => {
        transcript.appendAssistant(message);
        if (pendingInterim !== undefined) {
          console.log(`[slack] interim message in ${threadId}: ${previewForLog(pendingInterim)}`);
        }
        pendingInterim = message;
      },
      // Only the final message is delivered to Slack.
      onFinal: async (finalText) => {
        finalSent = true;
        console.log(`[slack] final message in ${threadId}: ${previewForLog(finalText)}`);
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
      console.log(`[slack] final message in ${threadId}: ${previewForLog(result.text)}`);
      await indicator.pause();
      await reply.sendReply(result.text);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[slack] error handling turn in ${threadId}: ${message}`);
    await reply.sendReply(SLACK_TURN_ERROR_REPLY);
  } finally {
    await indicator.end();
    lease?.release();
  }
}
