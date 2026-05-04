export type SlackThreadId = string;

export type SlackCommandEvent = {
  threadId: SlackThreadId;
  channelId: string;
  reply(text: string): Promise<void>;
};

export type SlackMessageEvent = SlackCommandEvent & {
  text: string;
};

export type SlackHandlers = {
  onThreadStarted(event: SlackCommandEvent): Promise<void>;
  onMessage(event: SlackMessageEvent): Promise<void>;
};
