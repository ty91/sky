import type { SayFn } from '@slack/bolt';
import { computeBackoffMs, sleep } from '../runtime/retry.js';

export type SlackSenderOptions = {
  say: SayFn;
  setStatus: (status: string) => Promise<unknown>;
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

  private async sendWithRetry(text: string, maxAttempts = 4): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.options.say(text);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (attempt === maxAttempts) {
          throw error;
        }

        const delay = computeBackoffMs(attempt, { baseMs: 1000, maxMs: 10000 });
        console.log(`[slack] say failed (attempt ${attempt}/${maxAttempts}): ${message}, retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
}
