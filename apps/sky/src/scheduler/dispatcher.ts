import type { AgentConfig } from '../agents/types.js';
import type { ConversationManager } from '../conversation/manager.js';
import { withTimeout } from '../runtime/retry.js';
import { runProactiveAgentTurn } from '../slack/proactive-turn.js';
import { toThreadId } from '../slack/thread-id.js';
import type { ScheduledJob } from './types.js';

const SLACK_SCHEDULED_SEND_TIMEOUT_MS = 30_000;

function scheduledSessionKey(job: ScheduledJob): string {
  return `scheduled:${job.id}`;
}

function readPostedTs(response: unknown): string | undefined {
  if (typeof response !== 'object' || response === null) {
    return undefined;
  }
  const ts = (response as { ts?: unknown }).ts;
  return typeof ts === 'string' && ts.length > 0 ? ts : undefined;
}

export type ScheduledSlackMessage = {
  channel: string;
  text: string;
};

export type ScheduledJobDispatcher = {
  dispatch(job: ScheduledJob): Promise<void>;
  notifyFailure(job: ScheduledJob, error: Error, attempts: number): Promise<void>;
};

export type ScheduledJobDispatcherOptions = {
  conversationManager: Pick<ConversationManager, 'runTurn' | 'rekey'>;
  mainAgent: AgentConfig;
  postMessage(message: ScheduledSlackMessage): Promise<unknown>;
  sendTimeoutMs?: number;
};

function buildScheduledJobNotice(job: ScheduledJob): string {
  return [
    '<system-reminder>',
    'This is a synthetic scheduled trigger from the Sky harness, not a user message.',
    `Reminder title: ${job.title}`,
    `Scheduled time: ${new Date(job.nextRunAt).toISOString()} (${job.timezone})`,
    '',
    'Respond with the reminder that should be sent to 태영님 now.',
    `Instruction: ${job.prompt}`,
    '</system-reminder>',
  ].join('\n');
}

export function createScheduledJobDispatcher(
  options: ScheduledJobDispatcherOptions,
): ScheduledJobDispatcher {
  const sendTimeoutMs = options.sendTimeoutMs ?? SLACK_SCHEDULED_SEND_TIMEOUT_MS;

  return {
    async dispatch(job: ScheduledJob): Promise<void> {
      const sessionKey = scheduledSessionKey(job);
      let postedTs: string | undefined;

      const sendFinal = async (text: string): Promise<void> => {
        const response = await withTimeout(
          options.postMessage({ channel: job.targetChannel, text }),
          sendTimeoutMs,
          'Slack scheduled reminder send',
        );
        // The reminder lands as a new root message; its ts becomes the thread_ts
        // of any reply. Capture it so we can re-key the session below.
        postedTs = readPostedTs(response) ?? postedTs;
      };

      const result = await runProactiveAgentTurn({
        conversationManager: options.conversationManager,
        mainAgent: options.mainAgent,
        sessionKey,
        prompt: buildScheduledJobNotice(job),
        deliverFinal: sendFinal,
      });

      if (result.kind === 'interrupted') {
        throw new Error(`Scheduled reminder ${job.id} agent turn was interrupted.`);
      }
      if (result.kind === 'error') {
        throw result.error;
      }

      // Move the just-completed proactive session onto the Slack thread key so a
      // reply in the reminder's thread resumes this conversation instead of
      // starting a fresh one. Without a delivered ts there's no thread to bind.
      if (postedTs) {
        options.conversationManager.rekey(sessionKey, toThreadId(job.targetChannel, postedTs));
      }
    },

    async notifyFailure(job: ScheduledJob, error: Error, attempts: number): Promise<void> {
      await withTimeout(
        options.postMessage({
          channel: job.targetChannel,
          text: `리마인더 "${job.title}" 실행이 ${attempts}회 실패했습니다: ${error.message}`,
        }),
        sendTimeoutMs,
        'Slack scheduled reminder failure send',
      );
    },
  };
}
