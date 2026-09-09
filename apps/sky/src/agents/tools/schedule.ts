import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isValidCronExpr, nextCronRun } from '../../scheduler/cron.js';
import type { ScheduledJobStore } from '../../scheduler/types.js';
import type { AgentToolSpec } from '../backend/types.js';

const REMINDER_TIMEZONE = 'Asia/Seoul';

export const SCHEDULE_REMINDER_TOOL_NAME = 'schedule_reminder';
export const LIST_SCHEDULED_TOOL_NAME = 'list_scheduled';
export const CANCEL_SCHEDULED_TOOL_NAME = 'cancel_scheduled';

export type ScheduledToolDependencies = {
  store: ScheduledJobStore;
  channelId: string;
  now?: () => number;
  createId?: () => string;
};

type ScheduleReminderInput = {
  when?: string;
  cron?: string;
  prompt: string;
  title?: string;
  channelId?: string;
};

const SCHEDULE_REMINDER_INPUT_SCHEMA = {
  when: z
    .string()
    .optional()
    .describe(
      'For a one-shot reminder: ISO8601 timestamp with an explicit UTC offset, calculated before calling this tool. Provide either `when` or `cron`, not both.',
    ),
  cron: z
    .string()
    .min(1)
    .optional()
    .describe(
      'For a recurring reminder: a standard 5-field cron expression (minute hour day-of-month month day-of-week), evaluated in Asia/Seoul. Example: "30 8 * * *" runs every day at 08:30 KST. Provide either `when` or `cron`, not both.',
    ),
  prompt: z.string().min(1).describe('Instruction for the agent turn that will produce the reminder.'),
  title: z.string().min(1).optional().describe('Short human-readable reminder title.'),
  channelId: z
    .string()
    .min(1)
    .optional()
    .describe('Slack channel ID. Defaults to the current conversation channel.'),
};

function parseWhen(value: string): number | undefined {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function createScheduledToolSpecs(deps: ScheduledToolDependencies): AgentToolSpec[] {
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? randomUUID;

  return [
    {
      name: SCHEDULE_REMINDER_TOOL_NAME,
      label: 'Schedule reminder',
      description: [
        'Schedule a reminder that wakes the main agent and sends a new Slack root message.',
        'For a one-shot reminder, pass `when` as an absolute future ISO8601 timestamp with an explicit UTC offset.',
        'For a recurring reminder, pass `cron` as a standard 5-field cron expression (evaluated in Asia/Seoul).',
        'Provide exactly one of `when` or `cron`.',
      ].join(' '),
      inputSchema: SCHEDULE_REMINDER_INPUT_SCHEMA,
      async execute(rawInput) {
        const input = rawInput as ScheduleReminderInput;
        const currentTime = now();
        const cronExpr = input.cron?.trim();
        const whenValue = input.when?.trim();

        if (cronExpr && whenValue) {
          return {
            content: [
              {
                type: 'text',
                text: 'Reminder was not scheduled: provide either `when` (one-shot) or `cron` (recurring), not both.',
              },
            ],
            isError: true,
          };
        }

        const targetChannel = input.channelId?.trim() || deps.channelId;
        const title = input.title?.trim() || '리마인더';

        if (cronExpr) {
          if (!isValidCronExpr(cronExpr)) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Reminder was not scheduled: "${cronExpr}" is not a valid cron expression.`,
                },
              ],
              isError: true,
            };
          }

          const nextRunAt = nextCronRun(cronExpr, REMINDER_TIMEZONE, currentTime);
          const job = deps.store.create({
            id: createId(),
            title,
            kind: 'cron',
            nextRunAt,
            cronExpr,
            timezone: REMINDER_TIMEZONE,
            targetChannel,
            threadStrategy: 'new-root',
            deliveryMode: 'agent',
            prompt: input.prompt,
            createdAt: currentTime,
          });

          return {
            content: [
              {
                type: 'text',
                text: `Scheduled recurring reminder "${job.title}" (cron "${cronExpr}"), next run ${new Date(job.nextRunAt).toISOString()}.`,
              },
            ],
            details: {
              id: job.id,
              title: job.title,
              cron: cronExpr,
              nextRun: new Date(job.nextRunAt).toISOString(),
              timezone: job.timezone,
              channelId: job.targetChannel,
            },
          };
        }

        const nextRunAt = whenValue ? parseWhen(whenValue) : undefined;
        if (nextRunAt === undefined || nextRunAt <= currentTime) {
          return {
            content: [
              {
                type: 'text',
                text: 'Reminder was not scheduled: `when` must be a future ISO8601 timestamp with an explicit UTC offset, or provide a `cron` expression.',
              },
            ],
            isError: true,
          };
        }

        const job = deps.store.create({
          id: createId(),
          title,
          kind: 'once',
          nextRunAt,
          timezone: REMINDER_TIMEZONE,
          targetChannel,
          threadStrategy: 'new-root',
          deliveryMode: 'agent',
          prompt: input.prompt,
          createdAt: currentTime,
        });

        return {
          content: [
            {
              type: 'text',
              text: `Scheduled reminder "${job.title}" for ${new Date(job.nextRunAt).toISOString()}.`,
            },
          ],
          details: {
            id: job.id,
            title: job.title,
            when: new Date(job.nextRunAt).toISOString(),
            timezone: job.timezone,
            channelId: job.targetChannel,
          },
        };
      },
    },
    {
      name: LIST_SCHEDULED_TOOL_NAME,
      label: 'List scheduled reminders',
      description: 'List reminders that are pending or currently running.',
      inputSchema: {},
      async execute() {
        const jobs = deps.store
          .list()
          .filter((job) => job.status === 'pending' || job.status === 'running');
        const summaries = jobs.map((job) => ({
          id: job.id,
          title: job.title,
          when: new Date(job.nextRunAt).toISOString(),
          timezone: job.timezone,
          channelId: job.targetChannel,
          status: job.status,
        }));
        const text =
          jobs.length === 0
            ? 'No scheduled reminders.'
            : jobs
                .map((job) => {
                  const when = new Date(job.nextRunAt).toISOString();
                  return job.kind === 'cron'
                    ? `${job.id}: ${job.title} [cron "${job.cronExpr}"] next ${when} (${job.timezone})`
                    : `${job.id}: ${job.title} at ${when} (${job.timezone})`;
                })
                .join('\n');
        return {
          content: [{ type: 'text', text }],
          details: { jobs: summaries },
        };
      },
    },
    {
      name: CANCEL_SCHEDULED_TOOL_NAME,
      label: 'Cancel scheduled reminder',
      description: 'Cancel a pending scheduled reminder by its ID.',
      inputSchema: {
        id: z.string().min(1).describe('Scheduled reminder ID returned by the scheduling tools.'),
      },
      async execute(rawInput) {
        const { id } = rawInput as { id: string };
        const cancelled = deps.store.cancel(id);
        return {
          content: [
            {
              type: 'text',
              text: cancelled
                ? `Cancelled scheduled reminder ${id}.`
                : `Scheduled reminder ${id} was not pending or does not exist.`,
            },
          ],
          details: { id, cancelled },
          ...(!cancelled ? { isError: true } : {}),
        };
      },
    },
  ];
}
