import type { ConversationManager, ConversationSummary } from '../conversation/manager.js';
import type { ScheduledJob, ScheduledJobStore } from '../scheduler/types.js';
import { SLACK_THREAD_LINK_PROVIDER } from '../slack/thread-id.js';

export type RuntimeSessionSummary = {
  conversationId: string;
  threadKey: string | null;
  backendSessionId: string;
  backend: string;
  model: string;
  agent: string;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeScheduledJobSummary = {
  id: string;
  title: string;
  kind: ScheduledJob['kind'];
  nextRunAt: string;
  timezone: string;
  target: string;
  status: ScheduledJob['status'];
  lastRunAt: string | null;
  runCount: number;
  errorSummary: string | null;
};

export type RuntimeScheduledJobCancelResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'status_conflict'; status: ScheduledJob['status'] };

export type RuntimeSessionTarget = { threadKey: string } | { conversationId: string };

export type RuntimeSessionsSnapshot = {
  sessions: RuntimeSessionSummary[];
};

export type RuntimeScheduledJobsSnapshot = {
  jobs: RuntimeScheduledJobSummary[];
};

export type RuntimeAdmin = {
  listSessions(): Promise<RuntimeSessionSummary[]>;
  resetSession(target: RuntimeSessionTarget): Promise<{ reset: boolean }>;
  listScheduledJobs(): RuntimeScheduledJobSummary[];
  cancelScheduledJob(jobId: string): RuntimeScheduledJobCancelResult;
};

function toSessionSummary(conversation: ConversationSummary): RuntimeSessionSummary {
  return {
    conversationId: conversation.conversationId,
    threadKey:
      conversation.links.find((link) => link.provider === SLACK_THREAD_LINK_PROVIDER)?.externalId ?? null,
    backendSessionId: conversation.sessionId,
    backend: conversation.backend,
    model: conversation.model,
    agent: conversation.agentName,
    createdAt: new Date(conversation.createdAt).toISOString(),
    updatedAt: new Date(conversation.updatedAt).toISOString(),
  };
}

function safeErrorSummary(lastError: string | null): string | null {
  return lastError === null ? null : 'The most recent run failed.';
}

function toScheduledJobSummary(job: ScheduledJob): RuntimeScheduledJobSummary {
  return {
    id: job.id,
    title: job.title,
    kind: job.kind,
    nextRunAt: new Date(job.nextRunAt).toISOString(),
    timezone: job.timezone,
    target: job.targetChannel,
    status: job.status,
    lastRunAt: job.lastRunAt === null ? null : new Date(job.lastRunAt).toISOString(),
    runCount: job.runCount,
    errorSummary: safeErrorSummary(job.lastError),
  };
}

export function createRuntimeAdmin(
  conversationManager: ConversationManager,
  scheduledJobStore: ScheduledJobStore,
): RuntimeAdmin {
  return {
    async listSessions() {
      return (await conversationManager.list()).map(toSessionSummary);
    },

    async resetSession(target) {
      const conversationId = 'threadKey' in target
        ? conversationManager.find({ provider: SLACK_THREAD_LINK_PROVIDER, externalId: target.threadKey })
        : conversationManager.get(target.conversationId)?.id;
      if (conversationId === undefined) return { reset: false };
      return { reset: await conversationManager.purge(conversationId) };
    },

    listScheduledJobs() {
      return scheduledJobStore.list().map(toScheduledJobSummary);
    },

    cancelScheduledJob(jobId) {
      if (scheduledJobStore.cancel(jobId)) return { ok: true };
      const job = scheduledJobStore.get(jobId);
      return job
        ? { ok: false, reason: 'status_conflict', status: job.status }
        : { ok: false, reason: 'not_found' };
    },
  };
}
