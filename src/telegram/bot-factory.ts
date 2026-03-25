import { Bot, type ApiClientOptions } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { TelegramSender } from './sender.js';
import type { TelegramBotIdentity, TelegramHandlers, TelegramLifecycleEvents } from './transport.js';

export type TelegramBotFactoryOptions = {
  botToken: string;
  identity: TelegramBotIdentity;
  fetch: typeof fetch;
  handlers: TelegramHandlers;
  events: TelegramLifecycleEvents;
};

function toBotInfo(identity: TelegramBotIdentity): UserFromGetMe {
  return {
    id: identity.id,
    is_bot: true,
    first_name: identity.username,
    username: identity.username,
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
  } satisfies UserFromGetMe;
}

export function createTelegramBot(options: TelegramBotFactoryOptions): Bot {
  const fetchForClient = options.fetch as unknown as NonNullable<ApiClientOptions['fetch']>;
  const bot = new Bot(options.botToken, {
    botInfo: toBotInfo(options.identity),
    client: {
      fetch: fetchForClient,
    },
  });

  const sender = new TelegramSender(
    {
      sendMessage: (chatId, text) => bot.api.sendMessage(chatId, text),
      sendChatAction: (chatId, action) => bot.api.sendChatAction(chatId, action),
    },
    {
      onSuccess: (method) => options.events.onOutboundSuccess(method),
      onFailure: (error) => options.events.onOutboundFailure(error),
    },
  );

  bot.catch(async (error) => {
    await options.events.onMiddlewareError(error.error ?? error);
  });

  bot.use(async (_ctx, next) => {
    options.events.onUpdateReceived();
    await next();
  });

  bot.command('start', async (ctx) => {
    console.log(`[telegram] /start from chat ${ctx.chat.id}`);
    await options.handlers.onStartCommand({
      chatId: ctx.chat.id,
      reply: async (text) => sender.sendMessage(ctx.chat.id, text),
    });
  });

  bot.command('new', async (ctx) => {
    console.log(`[telegram] /new from chat ${ctx.chat.id}`);
    await options.handlers.onNewCommand({
      chatId: ctx.chat.id,
      reply: async (text) => sender.sendMessage(ctx.chat.id, text),
    });
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    console.log(`[telegram] text from ${ctx.chat.id}: ${JSON.stringify(text)}`);
    await options.handlers.onTextMessage({
      chatId: ctx.chat.id,
      text,
      reply: async (message) => sender.sendMessage(ctx.chat.id, message),
      createTypingLoop: (intervalMs) => sender.createTypingLoop(ctx.chat.id, intervalMs),
    });
  });

  return bot;
}
