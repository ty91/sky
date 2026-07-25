export type ScheduledJobKind = 'once' | 'cron';
export type ScheduledJobStatus = 'pending' | 'running' | 'done' | 'cancelled' | 'failed';
export type ScheduledJobThreadStrategy = 'new-root';
export type ScheduledJobDeliveryMode = 'agent';
export type ScheduledJobFailureOutcome = 'retrying' | 'failed';

export type ScheduledJob = {
  id: string;
  title: string;
  kind: ScheduledJobKind;
  nextRunAt: number;
  cronExpr: string | null;
  timezone: string;
  targetChannel: string;
  threadStrategy: ScheduledJobThreadStrategy;
  deliveryMode: ScheduledJobDeliveryMode;
  prompt: string;
  status: ScheduledJobStatus;
  createdAt: number;
  lastRunAt: number | null;
  runCount: number;
  lastError: string | null;
};

export type NewScheduledJob = Omit<
  ScheduledJob,
  'cronExpr' | 'status' | 'lastRunAt' | 'runCount' | 'lastError'
> & {
  cronExpr?: string | null;
};

export interface ScheduledJobStore {
  create(job: NewScheduledJob): ScheduledJob;
  list(): ScheduledJob[];
  cancel(id: string): boolean;
  claimDue(now: number): ScheduledJob[];
  claimDueCron(now: number): ScheduledJob[];
  rearmCron(id: string, nextRunAt: number, lastError?: string | null): boolean;
  markDone(id: string): boolean;
  recordFailure(
    id: string,
    error: string,
    retryAt: number,
    maxAttempts: number,
  ): ScheduledJobFailureOutcome | undefined;
  skipOverdue(before: number): number;
  failRunningBefore(before: number, error: string): ScheduledJob[];
  close(): void;
}
