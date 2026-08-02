import type { AgentConfig } from '../agents/types.js';
import type { ConversationManager } from '../conversation/manager.js';
import type { ThreadModelStore } from '../conversation/thread-model-store.js';
import type { RuntimeController } from '../runtime/controller.js';
import { createStatusIndicator, type AssistantStatusClient } from './activity-indicator.js';
import { maybeHandleChatCommand, stripLeadingMentionLabel } from './commands.js';
import { normalizeSlackMessage, type SlackChannelMessageEvent } from './messages.js';
import { SlackSender } from './sender.js';
import { prependSlackThreadHistoryToPrompt, type SlackThreadMessage } from './thread-history.js';
import { toThreadId } from './thread-id.js';
import { executeSlackTurn, SLACK_DRAINING_REPLY } from './turn.js';
import { prefixSlackUserMessage, type SlackUserNameResolver } from './users.js';

export type SlackChannelEvent = SlackChannelMessageEvent & {
  channel?: string;
  thread_ts?: string;
  ts?: string;
};

export type SlackChannelClient = AssistantStatusClient & {
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
  threadModelStore: ThreadModelStore;
  userNameResolver?: SlackUserNameResolver;
  runtimeController?: Pick<RuntimeController, 'isAccepting' | 'lease'>;
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
  threadModelStore,
  userNameResolver,
  runtimeController,
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

      if (runtimeController && !runtimeController.isAccepting()) {
        await sender.sendReply(SLACK_DRAINING_REPLY);
        return;
      }

      // Chat commands are matched against the mention-stripped text, before the
      // `<@user>:` prefix and any thread history are added.
      const handledCommand = await maybeHandleChatCommand({
        threadId,
        rawText: stripLeadingMentionLabel(normalized.text, mentionLabel),
        conversationManager,
        threadModelStore,
        reply: sender,
      });
      if (handledCommand) {
        return;
      }

      const userId = readNonEmptyString(event.user);
      const displayName = userId ? await userNameResolver?.getDisplayName(userId) : undefined;
      const currentContent = prefixSlackUserMessage(normalized.text, userId, displayName);

      const text = await maybePrependThreadHistory({
        channelId,
        currentContent,
        includeHistory: !existingThread,
        latest: messageTs,
        slack,
        threadTs,
        userNameResolver,
      });

      const indicator = createStatusIndicator({
        client: slack,
        channelId,
        threadTs,
      });

      await executeSlackTurn({
        threadId,
        text,
        conversationManager,
        mainAgent,
        indicator,
        reply: sender,
        runtimeController,
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
  userNameResolver,
}: {
  channelId: string;
  currentContent: string;
  includeHistory: boolean;
  latest: string;
  slack: SlackChannelClient;
  threadTs: string;
  userNameResolver?: SlackUserNameResolver;
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
      userDisplayNames: await resolveSlackThreadUserDisplayNames(messages, userNameResolver),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[slack] thread history fetch failed channel=${channelId} thread_ts=${threadTs}: ${message}`);
    return currentContent;
  }
}

async function resolveSlackThreadUserDisplayNames(
  messages: SlackThreadMessage[],
  userNameResolver?: SlackUserNameResolver,
): Promise<ReadonlyMap<string, string | undefined>> {
  const displayNames = new Map<string, string | undefined>();
  if (!userNameResolver) {
    return displayNames;
  }

  const userIds = [...new Set(messages.flatMap((message) => {
    const userId = message.user?.trim();
    return userId ? [userId] : [];
  }))];

  await Promise.all(userIds.map(async (userId) => {
    displayNames.set(userId, await userNameResolver.getDisplayName(userId));
  }));

  return displayNames;
}

function readNonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
