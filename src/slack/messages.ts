export type SlackChannelMessageEvent = {
  bot_id?: string;
  subtype?: string;
  text?: string;
  user?: string;
};

export type NormalizeSlackMessageInput = {
  allowUnmentionedChannelMessage?: boolean;
  botUserId: string;
  event: SlackChannelMessageEvent;
  mentionLabel?: string;
};

export type NormalizedSlackMessage =
  | {
      ignored: false;
      text: string;
    }
  | {
      ignored: true;
      reason: 'bot_message' | 'empty' | 'missing_channel_mention' | 'slack_subtype' | 'unknown_bot';
    };

export function normalizeSlackMessage({
  allowUnmentionedChannelMessage = false,
  botUserId,
  event,
  mentionLabel = '@sky',
}: NormalizeSlackMessageInput): NormalizedSlackMessage {
  const normalizedBotUserId = botUserId.trim();

  if (!normalizedBotUserId) {
    return { ignored: true, reason: 'unknown_bot' };
  }

  if (event.subtype) {
    return { ignored: true, reason: 'slack_subtype' };
  }

  if (event.bot_id || event.user === normalizedBotUserId) {
    return { ignored: true, reason: 'bot_message' };
  }

  const text = event.text?.trim() ?? '';
  if (!text) {
    return { ignored: true, reason: 'empty' };
  }

  const mentionPattern = createBotMentionPattern(normalizedBotUserId);
  const normalizedText = text.replace(mentionPattern, mentionLabel).trim();

  if (normalizedText === text) {
    if (allowUnmentionedChannelMessage) {
      return { ignored: false, text };
    }

    return { ignored: true, reason: 'missing_channel_mention' };
  }

  return { ignored: false, text: normalizedText };
}

function createBotMentionPattern(botUserId: string): RegExp {
  return new RegExp(`<@${escapeRegExp(botUserId)}(?:\\|[^>]+)?>`, 'g');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
