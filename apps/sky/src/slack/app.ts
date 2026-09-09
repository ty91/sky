import { App, SocketModeReceiver } from '@slack/bolt';
import { withTimeout } from '../runtime/retry.js';
import type { AgentConfig } from '../agents/types.js';
import type { ConversationManager } from '../conversation/manager.js';
import type { ThreadModelStore } from '../conversation/thread-model-store.js';
import type { RuntimeController } from '../runtime/controller.js';
import type { SkyHome } from '../sky-home.js';
import {
  createSlackAgentDmHandler,
  type SlackAgentDmMessageEvent,
} from './agent-dm.js';
import { createSlackAssistant } from './assistant.js';
import {
  createSlackChannelHandler,
  type SlackChannelEvent,
} from './channel.js';
import {
  createSlackChannelIngress,
  type SlackChannelMessageIngressEvent,
} from './channel-ingress.js';
import {
  readSlackThreadMessages,
  type SlackThreadMessage,
} from './thread-history.js';
import { createCachedSlackUserNameResolver } from './users.js';

export { isPublicOrPrivateChannelMessage } from './channel-ingress.js';

export type SlackSdk = {
  createApp(options: ConstructorParameters<typeof App>[0]): App;
  createReceiver(options: ConstructorParameters<typeof SocketModeReceiver>[0]): SocketModeReceiver;
};

export type SlackAppOptions = {
  sdk?: SlackSdk;
  signal?: AbortSignal;
  onConnectionState?: (state: 'connected' | 'retrying') => void;
  botToken: string;
  appToken: string;
  conversationManager: ConversationManager;
  mainAgent: AgentConfig;
  threadModelStore: ThreadModelStore;
  runtimeController: Pick<RuntimeController, 'isAccepting' | 'lease'>;
  skyHome: SkyHome;
};

export async function startSlackApp(options: SlackAppOptions): Promise<App> {
  const receiver = options.sdk
    ? options.sdk.createReceiver({ appToken: options.appToken, autoReconnectEnabled: false })
    : new SocketModeReceiver({ appToken: options.appToken, autoReconnectEnabled: false });
  const createApp = options.sdk?.createApp ?? ((settings) => new App(settings));
  const app = createApp({
    token: options.botToken,
    receiver,
    // Sky performs and awaits auth.test below. Bolt's eager constructor check creates an
    // unobserved rejecting Promise for invalid tokens before startup can enter retry mode.
    tokenVerificationEnabled: false,
  });

  let active = true;
  const connected = () => { if (active) options.onConnectionState?.('connected'); };
  const disconnected = () => { if (active) options.onConnectionState?.('retrying'); };
  receiver.client.on('connected', connected);
  receiver.client.on('reconnecting', disconnected);
  receiver.client.on('disconnected', disconnected);
  receiver.client.on('close', disconnected);
  const detach = () => {
    active = false;
    receiver.client.off('connected', connected);
    receiver.client.off('reconnecting', disconnected);
    receiver.client.off('disconnected', disconnected);
    receiver.client.off('close', disconnected);
  };
  slackCleanup.set(app, detach);
  const startup = async () => {
    const userNameResolver = createCachedSlackUserNameResolver(app.client);
    const assistant = createSlackAssistant({
      conversationManager: options.conversationManager,
      mainAgent: options.mainAgent,
      threadModelStore: options.threadModelStore,
      userNameResolver,
      runtimeController: options.runtimeController,
      skyHome: options.skyHome,
    });

    app.assistant(assistant);

    const auth = await app.client.auth.test();
    const botUserId = readAuthString(auth.user_id, 'Slack auth.test did not return user_id.');
    const channelHandler = createSlackChannelHandler({
      botUserId,
      conversationManager: options.conversationManager,
      mainAgent: options.mainAgent,
      threadModelStore: options.threadModelStore,
      slack: {
        assistant: {
          threads: {
            setStatus: async (params) => app.client.assistant.threads.setStatus(params),
          },
        },
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
      userNameResolver,
      runtimeController: options.runtimeController,
      skyHome: options.skyHome,
    });
    const channelIngress = createSlackChannelIngress({
      botUserId,
      channelHandler,
    });
    const agentDmHandler = createSlackAgentDmHandler({
      botUserId,
      conversationManager: options.conversationManager,
      mainAgent: options.mainAgent,
      threadModelStore: options.threadModelStore,
      slack: {
        assistant: {
          threads: {
            setStatus: async (params) => app.client.assistant.threads.setStatus(params),
          },
        },
        chat: {
          postMessage: async (message) => app.client.chat.postMessage(message),
        },
        reactions: {
          add: async (params) => app.client.reactions.add(params),
          remove: async (params) => app.client.reactions.remove(params),
        },
        token: options.botToken,
      },
      userNameResolver,
      runtimeController: options.runtimeController,
      skyHome: options.skyHome,
    });

    app.event('app_mention', async ({ event }) => {
      await channelIngress.handleAppMention({ event: event as SlackChannelEvent });
    });

    app.message(async ({ message }) => {
      const handledAgentDm = await agentDmHandler.handleMessage({ message: message as SlackAgentDmMessageEvent });
      if (handledAgentDm) {
        return;
      }

      await channelIngress.handleMessage({ message: message as SlackChannelMessageIngressEvent });
    });

    options.signal?.throwIfAborted();
    if (!active) throw new Error('Slack startup was stopped.');
    await app.start();
    if (!active || options.signal?.aborted) {
      await stopSlackApp(app);
      throw new Error('Slack startup was stopped.');
    }
    console.log('[slack] bolt app started (socket mode)');
    return app;
  };
  try {
    return await withTimeout(startup(), 30_000, 'Slack startup', options.signal);
  } catch (error) {
    await stopSlackApp(app);
    throw error;
  }
}

const slackCleanup = new WeakMap<App, () => void>();

export async function stopSlackApp(app: App): Promise<void> {
  slackCleanup.get(app)?.();
  slackCleanup.delete(app);
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
