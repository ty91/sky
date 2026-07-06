import type { AgentConfig } from '../agents/types.js';
import type { ConversationManager } from '../conversation/manager.js';
import { downloadSlackFiles, formatAttachmentsLine, type SlackFile } from './files.js';
import { SlackSender } from './sender.js';
import { toThreadId } from './thread-id.js';
import { executeSlackTurn } from './turn.js';
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

export type SlackAgentDmClient = {
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
  userNameResolver?: SlackUserNameResolver;
};

export type SlackAgentDmHandler = {
  handleMessage(input: { message: SlackAgentDmMessageEvent }): Promise<boolean>;
};

export function createSlackAgentDmHandler({
  botUserId,
  conversationManager,
  mainAgent,
  slack,
  userNameResolver,
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

      const sender = new SlackSender({
        say: async (replyText) => {
          await slack.chat.postMessage({
            channel: channelId,
            text: replyText,
            thread_ts: threadTs,
          });
        },
      });

      if (!text) {
        await sender.sendReply('빈 메시지는 처리할 수 없습니다.');
        return true;
      }

      const userId = readNonEmptyString(message.user);
      const displayName = userId ? await userNameResolver?.getDisplayName(userId) : undefined;
      const userText = prefixSlackUserMessage(text, userId, displayName);

      console.log(`[slack] agent DM root message in ${threadId}: ${JSON.stringify(userText)}`);

      await executeSlackTurn({
        threadId,
        channelId,
        messageTs,
        text: userText,
        conversationManager,
        mainAgent,
        reactionClient: slack,
        reply: sender,
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
