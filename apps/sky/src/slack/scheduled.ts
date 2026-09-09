import type { AgentConfig } from '../agents/types.js';
import type { ConversationManager } from '../conversation/manager.js';
import { withTimeout } from '../runtime/retry.js';
import { createScheduledJobDispatcher } from '../scheduler/dispatcher.js';
import type { ScheduledJob } from '../scheduler/types.js';
import { toThreadId } from './thread-id.js';

export type ScheduledSlackMessage = { channel: string; text: string };

export function createSlackScheduledDispatcher(options: {
  conversationManager: Pick<ConversationManager, 'runTurn' | 'rekey'>;
  mainAgent: AgentConfig | ((job: ScheduledJob) => AgentConfig);
  postMessage(message: ScheduledSlackMessage): Promise<unknown>;
  isAvailable?: () => boolean;
  sendTimeoutMs?: number;
}) {
  const sendTimeoutMs = options.sendTimeoutMs ?? 30_000;
  return createScheduledJobDispatcher({
    conversationManager: options.conversationManager,
    delivery: {
      isAvailable: () => options.isAvailable?.() ?? true,
      agent: (job) => typeof options.mainAgent === 'function' ? options.mainAgent(job) : options.mainAgent,
      async send(job, text) {
        const response = await withTimeout(
          options.postMessage({ channel: job.targetChannel, text }),
          sendTimeoutMs,
          'Slack scheduled reminder send',
        );
        const ts = response && typeof response === 'object' && 'ts' in response ? response.ts : undefined;
        return typeof ts === 'string' && ts.length > 0 ? toThreadId(job.targetChannel, ts) : undefined;
      },
      async notifyFailure(job, error, attempts) {
        await withTimeout(
          options.postMessage({
            channel: job.targetChannel,
            text: `리마인더 "${job.title}" 실행이 ${attempts}회 실패했습니다: ${error.message}`,
          }),
          sendTimeoutMs,
          'Slack scheduled reminder failure send',
        );
      },
    },
  });
}
