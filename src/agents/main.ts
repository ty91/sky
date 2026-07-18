import {
  createRestartHarnessToolSpec,
  RESTART_HARNESS_TOOL_NAME,
} from './tools/restart-harness.js';
import {
  createSlackAttachFilesToolSpec,
  SLACK_ATTACH_FILES_TOOL_NAME,
} from './tools/slack-attach-files.js';
import {
  CANCEL_SCHEDULED_TOOL_NAME,
  createScheduledToolSpecs,
  LIST_SCHEDULED_TOOL_NAME,
  SCHEDULE_REMINDER_TOOL_NAME,
} from './tools/schedule.js';
import type { AgentToolSpec } from './backend/types.js';
import type { AgentEffort } from './effort.js';
import type { AgentConfig } from './types.js';
import type { SlackFileUploader } from '../slack/files.js';
import type { ScheduledJobStore } from '../scheduler/types.js';

const MAIN_AGENT_TOOLS = [
  'Bash',
  'Glob',
  'Grep',
  'Read',
  'Edit',
  'Write',
  'Skill',
  'TaskOutput',
  'TaskStop',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  RESTART_HARNESS_TOOL_NAME,
  SLACK_ATTACH_FILES_TOOL_NAME,
  SCHEDULE_REMINDER_TOOL_NAME,
  LIST_SCHEDULED_TOOL_NAME,
  CANCEL_SCHEDULED_TOOL_NAME,
] as const;

export type MainAgentConfigOptions = {
  /** Baseline prompt; also used for resumed sessions that have no stored snapshot. */
  systemPrompt: string;
  /** Called on new sessions so AGENTS.md/MEMORY.md edits take effect without a bot restart. */
  systemPromptLoader?: () => string;
  model?: string;
  effort?: AgentEffort;
  /** Test seam for the in-process restart signal. Production defaults to process.kill. */
  restartSignalParent?: (pid: number, signal: NodeJS.Signals) => void;
  /** Lazily resolves a Slack uploader for Slack-bound sessions. */
  slackFileUploaderProvider?: () => SlackFileUploader | undefined;
  scheduledJobStore?: ScheduledJobStore;
  schedulerClock?: () => number;
  schedulerIdFactory?: () => string;
};

function parseSessionKey(sessionKey: string): { channelId: string; threadTs: string } {
  // Slack session keys are `<channelId>:<threadTs>` per `slack/assistant.ts`.
  // Fall back to the whole string as channelId if the format ever changes so
  // downstream doesn't crash — the restart will still record but the
  // post-restart trigger won't have a valid thread to reply into.
  const idx = sessionKey.indexOf(':');
  if (idx === -1) return { channelId: sessionKey, threadTs: '' };
  return {
    channelId: sessionKey.slice(0, idx),
    threadTs: sessionKey.slice(idx + 1),
  };
}

export function createMainAgentConfig(options: MainAgentConfigOptions): AgentConfig {
  return {
    name: 'main',
    systemPrompt: options.systemPrompt,
    systemPromptLoader: options.systemPromptLoader,
    model: options.model ?? 'anthropic/claude-opus-4-7',
    ...(options.effort ? { effort: options.effort } : {}),
    tools: [...MAIN_AGENT_TOOLS],
    customToolsFactory: ({ sessionKey }) => {
      const { channelId, threadTs } = parseSessionKey(sessionKey);
      const tools: AgentToolSpec[] = [
        createRestartHarnessToolSpec(
          {
            sessionKey,
            channelId,
            threadTs,
            parentPid: process.pid,
          },
          options.restartSignalParent,
        ),
      ];

      if (options.slackFileUploaderProvider) {
        tools.push(
          createSlackAttachFilesToolSpec(
            {
              channelId,
              threadTs,
            },
            {
              uploadFiles: async (params) => {
                const uploader = options.slackFileUploaderProvider?.();
                if (!uploader) {
                  throw new Error('Slack file upload is unavailable: Slack app is not ready.');
                }
                return uploader.uploadFiles(params);
              },
            },
          ),
        );
      }

      if (options.scheduledJobStore) {
        tools.push(
          ...createScheduledToolSpecs({
            store: options.scheduledJobStore,
            channelId,
            now: options.schedulerClock,
            createId: options.schedulerIdFactory,
          }),
        );
      }

      return tools;
    },
  };
}
