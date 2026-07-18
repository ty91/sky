import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ScheduledJobStore } from '../../scheduler/types.js';
import type { AgentToolSpec } from '../backend/types.js';

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
  when: string;
  prompt: string;
  title?: string;
  channelId?: string;
};

const SCHEDULE_REMINDER_INPUT_SCHEMA = {
  when: z
    .string()
    .describe('ISO8601 timestamp with an explicit UTC offset, calculated before calling this tool.'),
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
        'Schedule a one-shot reminder that wakes the main agent and sends a new Slack root message.',
        'Convert natural-language times to an absolute ISO8601 timestamp before calling this tool.',
        'The timestamp must be in the future and include an explicit UTC offset.',
      ].join(' '),
      inputSchema: SCHEDULE_REMINDER_INPUT_SCHEMA,
      async execute(rawInput) {
        const input = rawInput as ScheduleReminderInput;
        const nextRunAt = parseWhen(input.when);
        const currentTime = now();
        if (nextRunAt === undefined || nextRunAt <= currentTime) {
          return {
            content: [
              {
                type: 'text',
                text: 'Reminder was not scheduled: when must be a future ISO8601 timestamp with an explicit UTC offset.',
              },
            ],
            isError: true,
          };
        }

        const targetChannel = input.channelId?.trim() || deps.channelId;
        const title = input.title?.trim() || '리마인더';
        const job = deps.store.create({
          id: createId(),
          title,
          kind: 'once',
          nextRunAt,
          timezone: 'Asia/Seoul',
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
          summaries.length === 0
            ? 'No scheduled reminders.'
            : summaries
                .map((job) => `${job.id}: ${job.title} at ${job.when} (${job.timezone})`)
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
