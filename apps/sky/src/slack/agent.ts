import { createMainAgentConfig, type MainAgentConfigOptions } from '../agents/main.js';
import { createSlackAttachFilesToolSpec, SLACK_ATTACH_FILES_TOOL_NAME } from '../agents/tools/slack-attach-files.js';
import { createScheduledToolSpecs, SCHEDULE_REMINDER_TOOL_NAME, LIST_SCHEDULED_TOOL_NAME, CANCEL_SCHEDULED_TOOL_NAME } from '../agents/tools/schedule.js';
import type { AgentToolSpec } from '../agents/backend/types.js';
import type { ScheduledJobStore } from '../scheduler/types.js';
import type { SlackFileUploader } from './files.js';

export type SlackAgentOptions = MainAgentConfigOptions & {
  slackFileUploaderProvider?: () => SlackFileUploader | undefined;
  scheduledJobStore?: ScheduledJobStore;
  schedulerClock?: () => number;
  schedulerIdFactory?: () => string;
  target?: { channelId: string; threadTs?: string };
};

export function createSlackAgentConfig(options: SlackAgentOptions) {
  return createMainAgentConfig({
    ...options,
    customToolNames: [
      ...(options.slackFileUploaderProvider ? [SLACK_ATTACH_FILES_TOOL_NAME] : []),
      ...(options.scheduledJobStore ? [SCHEDULE_REMINDER_TOOL_NAME, LIST_SCHEDULED_TOOL_NAME, CANCEL_SCHEDULED_TOOL_NAME] : []),
    ],
    customToolsFactory: ({ sessionKey }) => {
      const separator = sessionKey.indexOf(':');
      const target = options.target ?? {
        channelId: separator < 0 ? '' : sessionKey.slice(0, separator),
        threadTs: separator < 0 ? '' : sessionKey.slice(separator + 1),
      };
      const tools: AgentToolSpec[] = [];
      if (target.channelId && target.threadTs && options.slackFileUploaderProvider) {
        tools.push(createSlackAttachFilesToolSpec(
          { channelId: target.channelId, threadTs: target.threadTs },
          { uploadFiles: async (params) => {
            const uploader = options.slackFileUploaderProvider?.();
            if (!uploader) throw new Error('Slack file upload is unavailable: Slack app is not ready.');
            return uploader.uploadFiles(params);
          } },
        ));
      }
      if (target.channelId && options.scheduledJobStore) {
        tools.push(...createScheduledToolSpecs({
          store: options.scheduledJobStore,
          channelId: target.channelId,
          now: options.schedulerClock,
          createId: options.schedulerIdFactory,
        }));
      }
      return tools;
    },
  });
}
