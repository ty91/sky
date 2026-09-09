import type { AgentConfig } from '../agents/types.js';
import type { ConversationManager } from '../conversation/manager.js';
import { runProactiveAgentTurn } from '../conversation/proactive-turn.js';
import type { ScheduledJob } from './types.js';

export class ScheduledDeliveryError extends Error {
  constructor(cause: unknown) {
    super(`Reminder delivery failed after agent execution: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'ScheduledDeliveryError';
  }
}

export type ScheduledJobDelivery = {
  isAvailable(job: ScheduledJob): boolean;
  agent(job: ScheduledJob): AgentConfig;
  send(job: ScheduledJob, text: string): Promise<string | undefined>;
  notifyFailure(job: ScheduledJob, error: Error, attempts: number): Promise<void>;
};

export type ScheduledJobDispatcher = {
  isAvailable(job: ScheduledJob): boolean;
  dispatch(job: ScheduledJob): Promise<void>;
  notifyFailure(job: ScheduledJob, error: Error, attempts: number): Promise<void>;
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

export function createScheduledJobDispatcher(options: {
  conversationManager: Pick<ConversationManager, 'runTurn' | 'rekey'>;
  delivery: ScheduledJobDelivery;
}): ScheduledJobDispatcher {
  const { delivery, conversationManager } = options;
  return {
    isAvailable: (job) => delivery.isAvailable(job),
    async dispatch(job) {
      const sessionKey = `scheduled:${job.id}`;
      let deliveredKey: string | undefined;
      const result = await runProactiveAgentTurn({
        conversationManager,
        mainAgent: delivery.agent(job),
        sessionKey,
        prompt: buildScheduledJobNotice(job),
        deliverFinal: async (text) => {
          try {
            deliveredKey = await delivery.send(job, text);
          } catch (error) {
            throw new ScheduledDeliveryError(error);
          }
        },
      });
      if (result.kind === 'interrupted') {
        throw new Error(`Scheduled reminder ${job.id} agent turn was interrupted.`);
      }
      if (result.kind === 'error') throw result.error;
      if (deliveredKey) conversationManager.rekey(sessionKey, deliveredKey);
    },
    async notifyFailure(job, error, attempts) {
      if (delivery.isAvailable(job)) await delivery.notifyFailure(job, error, attempts);
    },
  };
}
