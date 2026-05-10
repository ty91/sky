import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { requestRestart, type PendingRestart } from '../../runtime/pending-restart.js';

/**
 * MCP tool name suffix. The full name exposed to the allowlist is
 * `mcp__<server>__<tool>`, i.e. `mcp__sky__restart_harness`.
 */
export const RESTART_HARNESS_SERVER_NAME = 'sky';
export const RESTART_HARNESS_TOOL_NAME = 'restart_harness';
export const RESTART_HARNESS_FQ_TOOL_NAME = `mcp__${RESTART_HARNESS_SERVER_NAME}__${RESTART_HARNESS_TOOL_NAME}`;

export type RestartHarnessContext = {
  /** Session key used by the session manager (e.g. `"C123:1234.5678"`). */
  sessionKey: string;
  /** Slack channel id for post-restart delivery. */
  channelId: string;
  /** Slack thread ts for post-restart delivery. */
  threadTs: string;
  /** Parent bot process to signal after a restart request is accepted. */
  parentPid?: number;
};

export type RestartHarnessInput = {
  reason?: string;
};

export type RestartHarnessToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

export type RestartHarnessPiToolDetails = {
  sessionKey: string;
  channelId: string;
  threadTs: string;
};

export const RESTART_HARNESS_DESCRIPTION = [
  'Restart the sky harness (this very process).',
  '',
  'Use ONLY when the user explicitly tells you the harness code has been',
  'rebuilt and must be reloaded. Do NOT call this on your own initiative.',
  '',
  'Calling this tool kills your current process a few seconds after it',
  'returns. The next turn you experience will be a synthetic post-restart',
  'trigger (delivered as a `<system-reminder>`) confirming the restart',
  'completed. Keep your user-facing reply brief — one sentence acknowledging',
  'the restart — then stop.',
].join('\n');

export function runRestartHarnessTool(
  ctx: RestartHarnessContext,
  input: RestartHarnessInput,
  signalParent: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): RestartHarnessToolResult {
  const info: PendingRestart = {
    sessionKey: ctx.sessionKey,
    channelId: ctx.channelId,
    threadTs: ctx.threadTs,
    reason: input.reason,
    requestedAt: Date.now(),
  };

  const result = requestRestart(info);
  if (!result.ok) {
    return {
      content: [
        {
          type: 'text',
          text: `Restart refused: ${result.reason} (retry in ${Math.ceil(result.remainingMs / 1000)}s).`,
        },
      ],
      isError: true,
    };
  }

  if (ctx.parentPid !== undefined) {
    signalParent(ctx.parentPid, 'SIGUSR2');
  }

  return {
    content: [
      {
        type: 'text',
        text: 'Restart scheduled. Inform 태영님 briefly that the harness is restarting, then stop — the post-restart trigger will arrive shortly.',
      },
    ],
  };
}

const RESTART_HARNESS_PARAMETERS = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description:
        'Short human-readable reason for the restart, surfaced back to you in the post-restart notice.',
    },
  },
  additionalProperties: false,
} as unknown as ToolDefinition['parameters'];

export function createRestartHarnessPiTool(
  ctx: RestartHarnessContext,
  signalParent: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): ToolDefinition<typeof RESTART_HARNESS_PARAMETERS, RestartHarnessPiToolDetails> {
  return {
    name: RESTART_HARNESS_TOOL_NAME,
    label: 'Restart harness',
    description: RESTART_HARNESS_DESCRIPTION,
    parameters: RESTART_HARNESS_PARAMETERS,
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      const input = params as RestartHarnessInput;
      const result = runRestartHarnessTool(ctx, input, signalParent);
      if (result.isError) {
        throw new Error(result.content.map((item) => item.text).join('\n'));
      }

      return {
        content: result.content,
        details: {
          sessionKey: ctx.sessionKey,
          channelId: ctx.channelId,
          threadTs: ctx.threadTs,
        },
      };
    },
  };
}
