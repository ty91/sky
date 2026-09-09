import type { AgentConfig } from '../agents/types.js';
import type { ConversationManager } from '../conversation/manager.js';
import type { ThreadModelStore } from '../conversation/thread-model-store.js';
import type { RuntimeController } from '../runtime/controller.js';
import type { SkyHome } from '../sky-home.js';
import { createStatusIndicator, type AssistantStatusClient } from './activity-indicator.js';
import { maybeHandleChatCommand } from './commands.js';
import { downloadSlackFiles, formatAttachmentsLine, type SlackFile } from './files.js';
import { SlackSender } from './sender.js';
import { toThreadId } from './thread-id.js';
import { executeSlackTurn, SLACK_DRAINING_REPLY } from './turn.js';
import { prefixSlackUserMessage, type SlackUserNameResolver } from './users.js';

export type SlackAgentDmMessageEvent = {
  bot_id?: string;
  channel?: string;
  channel_type?: unknown;
  files?: unknown;
  subtype?: string;
  text?: string;
  thread_ts?: unknown;
  ts?: string;
  user?: string;
};

export type SlackAgentDmClient = AssistantStatusClient & {
  chat: {
    postMessage(params: { channel: string; text: string; thread_ts: string }): Promise<unknown>;
  };
  reactions: {
    add(params: { channel: string; name: string; timestamp: string }): Promise<unknown>;
    remove(params: { channel: string; name: string; timestamp: string }): Promise<unknown>;
  };
  token?: string;
};

export type SlackAgentDmHandlerOptions = {
  botUserId: string;
  conversationManager: ConversationManager;
  mainAgent: AgentConfig;
  slack: SlackAgentDmClient;
  threadModelStore: ThreadModelStore;
  userNameResolver?: SlackUserNameResolver;
  runtimeController?: Pick<RuntimeController, 'isAccepting' | 'lease'>;
  skyHome?: SkyHome;
};

export type SlackAgentDmHandler = {
  handleMessage(input: { message: SlackAgentDmMessageEvent }): Promise<boolean>;
};

export function createSlackAgentDmHandler({
  botUserId,
  conversationManager,
  mainAgent,
  slack,
  threadModelStore,
  userNameResolver,
  runtimeController,
  skyHome,
}: SlackAgentDmHandlerOptions): SlackAgentDmHandler {
  return {
    async handleMessage({ message }) {
      if (!isAgentRootDmMessage(message, botUserId)) {
        return false;
      }

      const channelId = readNonEmptyString(message.channel);
      const messageTs = readNonEmptyString(message.ts);
      if (!channelId || !messageTs) {
        return true;
      }

      const threadTs = messageTs;
      const threadId = toThreadId(channelId, threadTs);
      const rawText = readNonEmptyString(message.text) ?? '';

      const sender = new SlackSender({
        say: async (replyText) => {
          await slack.chat.postMessage({
            channel: channelId,
            text: replyText,
            thread_ts: threadTs,
          });
        },
      });

      if (runtimeController && !runtimeController.isAccepting()) {
        await sender.sendReply(SLACK_DRAINING_REPLY);
        return true;
      }

      // Chat commands are matched against the raw text, before attachment
      // lines and the `<@user>:` prefix are added.
      const handledCommand = await maybeHandleChatCommand({
        threadId,
        rawText,
        conversationManager,
        threadModelStore,
        reply: sender,
      });
      if (handledCommand) {
        return true;
      }

      const files = Array.isArray(message.files) ? message.files as SlackFile[] : [];
      let attachmentsLine = '';

      if (files.length > 0) {
        console.log(`[slack] ${files.length} file(s) attached in ${threadId}`);
        const downloaded = await downloadSlackFiles(files, slack);
        attachmentsLine = formatAttachmentsLine(downloaded);
      }

      const text = attachmentsLine
        ? [rawText, attachmentsLine].filter(Boolean).join('\n\n')
        : rawText;

      if (!text) {
        await sender.sendReply('빈 메시지는 처리할 수 없습니다.');
        return true;
      }

      const userId = readNonEmptyString(message.user);
      const displayName = userId ? await userNameResolver?.getDisplayName(userId) : undefined;
      const userText = prefixSlackUserMessage(text, userId, displayName);

      console.log(`[slack] agent DM root message in ${threadId}: ${JSON.stringify(userText)}`);

      const indicator = createStatusIndicator({
        client: slack,
        channelId,
        threadTs,
      });

      await executeSlackTurn({
        threadId,
        text: userText,
        conversationManager,
        mainAgent,
        indicator,
        reply: sender,
        runtimeController,
        skyHome,
      });

      return true;
    },
  };
}

export function isAgentRootDmMessage(message: unknown, botUserId: string): message is SlackAgentDmMessageEvent {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const candidate = message as SlackAgentDmMessageEvent;
  if (candidate.channel_type !== 'im') {
    return false;
  }

  if (readNonEmptyString(candidate.thread_ts)) {
    return false;
  }

  const normalizedBotUserId = botUserId.trim();
  if (candidate.bot_id || (normalizedBotUserId && candidate.user === normalizedBotUserId)) {
    return false;
  }

  return !candidate.subtype || candidate.subtype === 'file_share';
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
