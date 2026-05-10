import type { SlackChannelEvent, SlackChannelHandler } from './channel.js';

export type SlackChannelIngressOptions = {
  botUserId: string;
  channelHandler: SlackChannelHandler;
};

export type SlackChannelMessageIngressEvent = SlackChannelEvent & {
  channel_type?: unknown;
};

export type SlackChannelIngress = {
  handleAppMention(input: { event: SlackChannelEvent }): Promise<void>;
  handleMessage(input: { message: SlackChannelMessageIngressEvent }): Promise<void>;
};

export function createSlackChannelIngress({ botUserId, channelHandler }: SlackChannelIngressOptions): SlackChannelIngress {
  return {
    async handleAppMention({ event }) {
      await channelHandler.handleMessage({ event });
    },

    async handleMessage({ message }) {
      if (!isPublicOrPrivateChannelMessage(message)) {
        return;
      }

      if (slackTextMentionsBotUser(message.text, botUserId)) {
        return;
      }

      await channelHandler.handleMessage({ event: message });
    },
  };
}

export function slackTextMentionsBotUser(text: unknown, botUserId: string): boolean {
  if (typeof text !== 'string') {
    return false;
  }

  const normalizedBotUserId = botUserId.trim();
  if (!normalizedBotUserId) {
    return false;
  }

  return new RegExp(`<@${escapeRegExp(normalizedBotUserId)}(?:\\|[^>]+)?>`).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isPublicOrPrivateChannelMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const channelType = 'channel_type' in message ? (message as { channel_type?: unknown }).channel_type : undefined;
  return channelType === 'channel' || channelType === 'group';
}
