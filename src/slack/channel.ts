import { TranscriptWriter } from '../agents/memory/transcript.js';
import type { AgentConfig } from '../agents/types.js';
import type { SessionManager } from '../session/manager.js';
import { normalizeSlackMessage, type SlackChannelMessageEvent } from './messages.js';
import { addReaction, removeReaction } from './reactions.js';
import { SlackSender } from './sender.js';
import { prependSlackThreadHistoryToPrompt, type SlackThreadMessage } from './thread-history.js';
import { toThreadId } from './thread-id.js';

export type SlackChannelEvent = SlackChannelMessageEvent & {
  channel?: string;
  thread_ts?: string;
  ts?: string;
};

export type SlackChannelClient = {
  chat: {
    postMessage(params: { channel: string; text: string; thread_ts: string }): Promise<unknown>;
  };
  fetchThreadMessages(params: {
    channel: string;
    latest: string;
    threadTs: string;
  }): Promise<SlackThreadMessage[]>;
  reactions: {
    add(params: { channel: string; name: string; timestamp: string }): Promise<unknown>;
    remove(params: { channel: string; name: string; timestamp: string }): Promise<unknown>;
  };
};

export type SlackChannelHandlerOptions = {
  botUserId: string;
  mainAgent: AgentConfig;
  mentionLabel?: string;
  sessionManager: SessionManager;
  slack: SlackChannelClient;
};

export type SlackChannelHandler = {
  handleMessage(input: { event: SlackChannelEvent }): Promise<void>;
};

export function createSlackChannelHandler({
  botUserId,
  mainAgent,
  mentionLabel = '@sky',
  sessionManager,
  slack,
}: SlackChannelHandlerOptions): SlackChannelHandler {
  return {
    async handleMessage({ event }) {
      const channelId = readNonEmptyString(event.channel);
      const messageTs = readNonEmptyString(event.ts);
      const threadTs = readNonEmptyString(event.thread_ts) ?? messageTs;

      if (!channelId || !messageTs || !threadTs) {
        return;
      }

      const threadId = toThreadId(channelId, threadTs);
      const existingThread = sessionManager.has(threadId, mainAgent);
      const normalized = normalizeSlackMessage({
        allowUnmentionedChannelMessage: existingThread,
        botUserId,
        event,
        mentionLabel,
      });

      if (normalized.ignored) {
        return;
      }

      const sender = new SlackSender({
        say: async (text) => {
          await slack.chat.postMessage({
            channel: channelId,
            text,
            thread_ts: threadTs,
          });
        },
      });
      const transcript = new TranscriptWriter(threadId);

      await addReaction(slack, channelId, messageTs, 'thought_balloon');

      try {
        sessionManager.open(threadId, mainAgent);

        const resumedId = sessionManager.getSessionId(threadId);
        if (resumedId) {
          transcript.setSessionId(resumedId);
        }

        const text = await maybePrependThreadHistory({
          channelId,
          currentContent: normalized.text,
          includeHistory: !existingThread,
          latest: messageTs,
          slack,
          threadTs,
        });

        transcript.appendUser(text);

        const result = await sessionManager.send(threadId, text, {
          onMessage: async (msg) => {
            const sessionId = sessionManager.getSessionId(threadId);
            if (sessionId) {
              transcript.setSessionId(sessionId);
            }
            transcript.appendAssistant(msg);
            await sender.sendReply(msg);
          },
        });

        if (result.kind === 'interrupted') {
          await addReaction(slack, channelId, messageTs, 'hand');
        } else if (result.kind === 'error') {
          throw result.error;
        } else {
          await addReaction(slack, channelId, messageTs, 'white_check_mark');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[slack] error handling channel message in ${threadId}: ${errorMessage}`);
        await sender.sendReply('오류가 났습니다. 잠시 뒤 다시 시도해 주세요.');
      } finally {
        await removeReaction(slack, channelId, messageTs, 'thought_balloon');
      }
    },
  };
}

async function maybePrependThreadHistory({
  channelId,
  currentContent,
  includeHistory,
  latest,
  slack,
  threadTs,
}: {
  channelId: string;
  currentContent: string;
  includeHistory: boolean;
  latest: string;
  slack: SlackChannelClient;
  threadTs: string;
}): Promise<string> {
  if (!includeHistory) {
    return currentContent;
  }

  try {
    const messages = await slack.fetchThreadMessages({
      channel: channelId,
      latest,
      threadTs,
    });

    return prependSlackThreadHistoryToPrompt({
      currentContent,
      messages,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[slack] thread history fetch failed channel=${channelId} thread_ts=${threadTs}: ${message}`);
    return currentContent;
  }
}

function readNonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
