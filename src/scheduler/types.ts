export type ScheduledJobKind = 'once' | 'cron';
export type ScheduledJobStatus = 'pending' | 'running' | 'done' | 'cancelled' | 'failed';
export type ScheduledJobThreadStrategy = 'new-root';
export type ScheduledJobDeliveryMode = 'agent';

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
  close(): void;
}
