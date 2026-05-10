import { App } from '@slack/bolt';
import type { AgentConfig } from '../agents/types.js';
import type { ConversationManager } from '../conversation/manager.js';
import type { SessionManager } from '../session/manager.js';
import { createSlackAssistant } from './assistant.js';
import {
  createSlackChannelHandler,
  type SlackChannelEvent,
} from './channel.js';
import {
  readSlackThreadMessages,
  type SlackThreadMessage,
} from './thread-history.js';

export type SlackAppOptions = {
  botToken: string;
  appToken: string;
  conversationManager: ConversationManager;
  sessionManager: SessionManager;
  mainAgent: AgentConfig;
};

export async function startSlackApp(options: SlackAppOptions): Promise<App> {
  const app = new App({
    token: options.botToken,
    appToken: options.appToken,
    socketMode: true,
  });

  const assistant = createSlackAssistant({
    conversationManager: options.conversationManager,
    mainAgent: options.mainAgent,
  });

  app.assistant(assistant);

  const auth = await app.client.auth.test();
  const botUserId = readAuthString(auth.user_id, 'Slack auth.test did not return user_id.');
  const channelHandler = createSlackChannelHandler({
    botUserId,
    sessionManager: options.sessionManager,
    mainAgent: options.mainAgent,
    slack: {
      chat: {
        postMessage: async (message) => app.client.chat.postMessage(message),
      },
      fetchThreadMessages: async ({ channel, latest, threadTs }) =>
        fetchThreadMessages(app, { channel, latest, threadTs }),
      reactions: {
        add: async (params) => app.client.reactions.add(params),
        remove: async (params) => app.client.reactions.remove(params),
      },
    },
  });

  app.event('app_mention', async ({ event }) => {
    await channelHandler.handleMessage({ event: event as SlackChannelEvent });
  });

  app.message(async ({ message }) => {
    if (!isPublicOrPrivateChannelMessage(message)) {
      return;
    }

    await channelHandler.handleMessage({ event: message as SlackChannelEvent });
  });

  await app.start();
  console.log('[slack] bolt app started (socket mode)');

  return app;
}

export async function stopSlackApp(app: App): Promise<void> {
  try {
    await app.stop();
    console.log('[slack] bolt app stopped');
  } catch (error) {
    console.error(`[slack] error stopping app: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchThreadMessages(
  app: App,
  {
    channel,
    latest,
    threadTs,
  }: {
    channel: string;
    latest: string;
    threadTs: string;
  },
): Promise<SlackThreadMessage[]> {
  const messages: SlackThreadMessage[] = [];
  let cursor: string | undefined;

  do {
    const response = await app.client.conversations.replies({
      channel,
      cursor,
      inclusive: false,
      latest,
      limit: Math.min(200, 100 - messages.length),
      ts: threadTs,
    });

    messages.push(...readSlackThreadMessages(response.messages));
    cursor = readNextCursor(response);
  } while (cursor && messages.length < 100);

  return messages.slice(0, 100);
}

function readAuthString(value: unknown, errorMessage: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  throw new Error(errorMessage);
}

function readNextCursor(response: { response_metadata?: { next_cursor?: unknown } }): string | undefined {
  const cursor = response.response_metadata?.next_cursor;
  return typeof cursor === 'string' && cursor.trim() ? cursor : undefined;
}

export function isPublicOrPrivateChannelMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const channelType = 'channel_type' in message ? (message as { channel_type?: unknown }).channel_type : undefined;
  return channelType === 'channel' || channelType === 'group';
}
