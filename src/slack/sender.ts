import type { SayFn } from '@slack/bolt';
import type { webApi } from '@slack/bolt';

type WebClient = webApi.WebClient;
import { computeBackoffMs, sleep } from '../runtime/retry.js';

export type SlackSenderOptions = {
  say: SayFn;
  setStatus: (status: string) => Promise<unknown>;
  computeDelayMs?: (attempt: number) => number;
  sleep?: (delayMs: number) => Promise<void>;
};

export type StreamOptions = {
  client: WebClient;
  channelId: string;
  threadTs: string;
  teamId: string;
  userId: string;
};

const MAX_SLACK_MESSAGE_LENGTH = 3500;

export class SlackSender {
  constructor(private readonly options: SlackSenderOptions) {}

  async setStatus(status: string): Promise<void> {
    try {
      await this.options.setStatus(status);
    } catch (error) {
      console.error(`[slack] setStatus failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async sendReply(text: string): Promise<void> {
    const chunks = text.match(new RegExp(`[\\s\\S]{1,${MAX_SLACK_MESSAGE_LENGTH}}`, 'g')) ?? ['(빈 응답)'];
    for (const chunk of chunks) {
      await this.sendWithRetry(chunk);
    }
  }

  createStreamer(streamOptions: StreamOptions) {
    const streamer = streamOptions.client.chatStream({
      channel: streamOptions.channelId,
      thread_ts: streamOptions.threadTs,
      recipient_team_id: streamOptions.teamId,
      recipient_user_id: streamOptions.userId,
    });

    return {
      append: async (markdownText: string): Promise<void> => {
        try {
          await streamer.append({ markdown_text: markdownText });
        } catch (error) {
          console.error(`[slack] stream append failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      stop: async (): Promise<void> => {
        try {
          await streamer.stop();
        } catch (error) {
          console.error(`[slack] stream stop failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    };
  }

  private async sendWithRetry(text: string, maxAttempts = 4): Promise<void> {
    const computeDelayMs =
      this.options.computeDelayMs ??
      ((attempt: number) => computeBackoffMs(attempt, { baseMs: 1000, maxMs: 10000 }));
    const sleepFn = this.options.sleep ?? ((delayMs: number) => sleep(delayMs));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.options.say(text);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (attempt === maxAttempts) {
          throw error;
        }

        const delay = computeDelayMs(attempt);
        console.log(`[slack] say failed (attempt ${attempt}/${maxAttempts}): ${message}, retrying in ${delay}ms`);
        await sleepFn(delay);
      }
    }
  }
}
