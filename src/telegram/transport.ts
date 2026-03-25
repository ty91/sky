import type { TypingLoop } from './sender.js';

export type TelegramBotIdentity = {
  id: number;
  username: string;
};

export type TelegramCommandEvent = {
  chatId: number;
  reply(text: string): Promise<void>;
};

export type TelegramTextEvent = TelegramCommandEvent & {
  text: string;
  createTypingLoop(intervalMs?: number): TypingLoop;
};

export type TransportSnapshot = {
  initialized: boolean;
  polling: boolean;
  identity?: TelegramBotIdentity;
  lastUpdateAt?: string;
};

export type TransportHandlers = {
  onStartCommand(event: TelegramCommandEvent): Promise<void>;
  onNewCommand(event: TelegramCommandEvent): Promise<void>;
  onTextMessage(event: TelegramTextEvent): Promise<void>;
  onUpdateReceived(): void;
  onPollingStarted(): void;
  onMiddlewareError(error: unknown): Promise<void>;
  onOutboundSuccess(method: 'sendMessage' | 'sendChatAction'): void;
  onOutboundFailure(error: unknown): void;
};

export interface TelegramTransport {
  initialize(signal?: AbortSignal): Promise<TelegramBotIdentity>;
  startPolling(): Promise<void>;
  stop(): Promise<void>;
  getSnapshot(): TransportSnapshot;
}
