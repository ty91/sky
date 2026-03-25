import { Bot } from 'grammy';
import { withTimeout } from '../runtime/retry.js';
import { TelegramSender } from './sender.js';
import type {
  TelegramBotIdentity,
  TelegramTransport,
  TransportHandlers,
  TransportSnapshot,
} from './transport.js';

export type LongPollingTransportOptions = {
  botToken: string;
  handlers: TransportHandlers;
  initTimeoutMs?: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class LongPollingTransport implements TelegramTransport {
  private readonly bot: Bot;
  private readonly sender: TelegramSender;
  private readonly snapshot: TransportSnapshot = {
    initialized: false,
    polling: false,
  };

  constructor(private readonly options: LongPollingTransportOptions) {
    this.bot = new Bot(options.botToken);
    this.sender = new TelegramSender(
      {
        sendMessage: (chatId, text) => this.bot.api.sendMessage(chatId, text),
        sendChatAction: (chatId, action) => this.bot.api.sendChatAction(chatId, action),
      },
      {
        onSuccess: (method) => this.options.handlers.onOutboundSuccess(method),
        onFailure: (error) => this.options.handlers.onOutboundFailure(error),
      },
    );

    this.bot.catch(async (error) => {
      await this.options.handlers.onMiddlewareError(error.error ?? error);
    });

    this.bot.use(async (_ctx, next) => {
      this.snapshot.lastUpdateAt = nowIso();
      this.options.handlers.onUpdateReceived();
      await next();
    });

    this.bot.command('start', async (ctx) => {
      console.log(`[telegram] /start from chat ${ctx.chat.id}`);
      await this.options.handlers.onStartCommand({
        chatId: ctx.chat.id,
        reply: async (text) => this.sender.sendMessage(ctx.chat.id, text),
      });
    });

    this.bot.command('new', async (ctx) => {
      console.log(`[telegram] /new from chat ${ctx.chat.id}`);
      await this.options.handlers.onNewCommand({
        chatId: ctx.chat.id,
        reply: async (text) => this.sender.sendMessage(ctx.chat.id, text),
      });
    });

    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text.trim();
      console.log(`[telegram] text from ${ctx.chat.id}: ${JSON.stringify(text)}`);
      await this.options.handlers.onTextMessage({
        chatId: ctx.chat.id,
        text,
        reply: async (message) => this.sender.sendMessage(ctx.chat.id, message),
        createTypingLoop: (intervalMs) => this.sender.createTypingLoop(ctx.chat.id, intervalMs),
      });
    });
  }

  async initialize(signal?: AbortSignal): Promise<TelegramBotIdentity> {
    await withTimeout(
      this.bot.init(),
      this.options.initTimeoutMs ?? 15000,
      'Telegram init',
      signal,
    );
    const identity = {
      id: this.bot.botInfo.id,
      username: this.bot.botInfo.username,
    };
    this.snapshot.initialized = true;
    this.snapshot.identity = identity;
    return identity;
  }

  async startPolling(): Promise<void> {
    await this.bot.start({
      onStart: async () => {
        this.snapshot.polling = true;
        this.options.handlers.onPollingStarted();
      },
    });
    this.snapshot.polling = false;
  }

  async stop(): Promise<void> {
    if (!this.snapshot.initialized) return;
    try {
      await this.bot.stop();
    } finally {
      this.snapshot.polling = false;
    }
  }

  getSnapshot(): TransportSnapshot {
    return { ...this.snapshot };
  }
}
