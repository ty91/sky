import { computeBackoffMs, sleep } from '../runtime/retry.js';

export type SlackSayFn = (text: string) => Promise<unknown>;

export type SlackSenderOptions = {
  say: SlackSayFn;
  computeDelayMs?: (attempt: number) => number;
  sleep?: (delayMs: number) => Promise<void>;
};

const MAX_SLACK_MESSAGE_LENGTH = 3500;

export class SlackSender {
  constructor(private readonly options: SlackSenderOptions) {}

  async sendReply(text: string): Promise<void> {
    const chunks = text.match(new RegExp(`[\\s\\S]{1,${MAX_SLACK_MESSAGE_LENGTH}}`, 'g')) ?? ['(빈 응답)'];
    for (const chunk of chunks) {
      await this.sendWithRetry(chunk);
    }
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
