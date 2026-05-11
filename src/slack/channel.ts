import type { AgentConfig } from '../agents/types.js';
import type { ConversationManager } from '../conversation/manager.js';
import { normalizeSlackMessage, type SlackChannelMessageEvent } from './messages.js';
import { SlackSender } from './sender.js';
import { prependSlackThreadHistoryToPrompt, type SlackThreadMessage } from './thread-history.js';
import { toThreadId } from './thread-id.js';
import { executeSlackTurn } from './turn.js';

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
  conversationManager: ConversationManager;
  mainAgent: AgentConfig;
  mentionLabel?: string;
  slack: SlackChannelClient;
};

export type SlackChannelHandler = {
  handleMessage(input: { event: SlackChannelEvent }): Promise<void>;
};

export function createSlackChannelHandler({
  botUserId,
  conversationManager,
  mainAgent,
  mentionLabel = '@sky',
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
      const existingThread = conversationManager.has(threadId, mainAgent);
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

      const text = await maybePrependThreadHistory({
        channelId,
        currentContent: normalized.text,
        includeHistory: !existingThread,
        latest: messageTs,
        slack,
        threadTs,
      });

      await executeSlackTurn({
        threadId,
        channelId,
        messageTs,
        text,
        conversationManager,
        mainAgent,
        reactionClient: slack,
        reply: sender,
      });
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
