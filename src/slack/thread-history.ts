export type SlackThreadMessage = {
  bot_id?: string;
  text?: string;
  ts: string;
  user?: string;
};

export type PrependSlackThreadHistoryInput = {
  currentContent: string;
  maxCharacters?: number;
  maxMessages?: number;
  messages: SlackThreadMessage[];
};

const DEFAULT_MAX_THREAD_HISTORY_CHARACTERS = 20_000;
const DEFAULT_MAX_THREAD_HISTORY_MESSAGES = 100;
const THREAD_HISTORY_HEADER = '[Slack thread history]';
const THREAD_HISTORY_TRUNCATED_LINE = '[Slack thread history truncated]';
const USER_REQUEST_HEADER = '[User request]';

export function prependSlackThreadHistoryToPrompt({
  currentContent,
  maxCharacters = DEFAULT_MAX_THREAD_HISTORY_CHARACTERS,
  maxMessages = DEFAULT_MAX_THREAD_HISTORY_MESSAGES,
  messages,
}: PrependSlackThreadHistoryInput): string {
  const history = formatSlackThreadHistory({
    maxCharacters,
    maxMessages,
    messages,
  });

  if (!history) {
    return currentContent;
  }

  return `${history}\n\n${USER_REQUEST_HEADER}\n${currentContent}`;
}

export function readSlackThreadMessages(value: unknown): SlackThreadMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((message) => {
    if (!isSlackThreadMessageRecord(message)) {
      return [];
    }

    const ts = readSlackString(message.ts);
    if (!ts) {
      return [];
    }

    return [
      {
        bot_id: readSlackString(message.bot_id),
        text: readSlackString(message.text),
        ts,
        user: readSlackString(message.user),
      },
    ];
  });
}

function formatSlackThreadHistory({
  maxCharacters,
  maxMessages,
  messages,
}: {
  maxCharacters: number;
  maxMessages: number;
  messages: SlackThreadMessage[];
}): string | undefined {
  const lines: string[] = [];
  let truncated = false;
  let includedMessages = 0;

  for (const message of messages) {
    const text = message.text?.trim();
    if (!text) {
      continue;
    }

    if (includedMessages >= maxMessages) {
      truncated = true;
      break;
    }

    const line = `${message.ts} ${readSlackThreadMessageAuthor(message)}: ${text}`;
    if (formatSlackThreadHistoryBlock(lines.concat(line)).length > maxCharacters) {
      truncated = true;
      break;
    }

    lines.push(line);
    includedMessages += 1;
  }

  if (lines.length === 0) {
    return undefined;
  }

  if (truncated) {
    while (
      lines.length > 0 &&
      formatSlackThreadHistoryBlock(lines.concat(THREAD_HISTORY_TRUNCATED_LINE)).length > maxCharacters
    ) {
      lines.pop();
    }

    if (formatSlackThreadHistoryBlock(lines.concat(THREAD_HISTORY_TRUNCATED_LINE)).length <= maxCharacters) {
      lines.push(THREAD_HISTORY_TRUNCATED_LINE);
    }
  }

  return formatSlackThreadHistoryBlock(lines);
}

function formatSlackThreadHistoryBlock(lines: string[]): string {
  return [THREAD_HISTORY_HEADER, ...lines].join('\n');
}

function readSlackThreadMessageAuthor(message: SlackThreadMessage): string {
  if (message.user?.trim()) {
    return message.user.trim();
  }

  if (message.bot_id?.trim()) {
    return `BOT:${message.bot_id.trim()}`;
  }

  return 'UNKNOWN';
}

function isSlackThreadMessageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readSlackString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
