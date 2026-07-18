import type { AgentConfig } from '../agents/types.js';
import type { ConversationManager } from '../conversation/manager.js';
import { withTimeout } from '../runtime/retry.js';
import type { ScheduledJob } from './types.js';

const SLACK_SCHEDULED_SEND_TIMEOUT_MS = 30_000;

export type ScheduledSlackMessage = {
  channel: string;
  text: string;
};

export type ScheduledJobDispatcher = {
  dispatch(job: ScheduledJob): Promise<void>;
  notifyFailure(job: ScheduledJob, error: Error, attempts: number): Promise<void>;
};

export type ScheduledJobDispatcherOptions = {
  conversationManager: Pick<ConversationManager, 'runTurn'>;
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
      let finalSent = false;
      const sendFinal = async (text: string): Promise<void> => {
        finalSent = true;
        await withTimeout(
          options.postMessage({ channel: job.targetChannel, text }),
          sendTimeoutMs,
          'Slack scheduled reminder send',
        );
      };

      const result = await options.conversationManager.runTurn(
        `scheduled:${job.id}`,
        options.mainAgent,
        buildScheduledJobNotice(job),
        { onFinal: sendFinal },
      );

      if (result.kind === 'interrupted') {
        throw new Error(`Scheduled reminder ${job.id} agent turn was interrupted.`);
      }
      if (result.kind === 'error') {
        throw result.error;
      }
      if (!finalSent && result.text) {
        await sendFinal(result.text);
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
