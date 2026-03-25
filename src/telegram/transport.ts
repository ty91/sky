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

export type TelegramHandlers = {
  onStartCommand(event: TelegramCommandEvent): Promise<void>;
  onNewCommand(event: TelegramCommandEvent): Promise<void>;
  onTextMessage(event: TelegramTextEvent): Promise<void>;
};

export type TelegramLifecycleEvents = {
  onProbeStart(): void;
  onProbeSuccess(identity: TelegramBotIdentity): void;
  onPollingStart(): void;
  onPollingStop(): void;
  onUpdateReceived(): void;
  onMiddlewareError(error: unknown): Promise<void>;
  onOutboundSuccess(method: 'sendMessage' | 'sendChatAction'): void;
  onOutboundFailure(error: unknown): void;
};

export type TelegramPollingSessionResult =
  | { kind: 'stopped' }
  | { kind: 'stopped_unexpectedly'; error: Error }
  | { kind: 'failed'; phase: 'initialize' | 'polling'; error: unknown };
