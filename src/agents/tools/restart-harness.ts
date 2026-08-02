import { z } from 'zod';
import type { AgentToolSpec } from '../backend/types.js';
import type { RuntimeController } from '../../runtime/controller.js';
import {
  requestRestart as recordPendingRestart,
  type PendingRestart,
} from '../../runtime/pending-restart.js';

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
  runtimeController: Pick<RuntimeController, 'requestRestart'>;
};

export type RestartHarnessInput = {
  reason?: string;
};

export type RestartHarnessToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

export type RestartHarnessToolDetails = {
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
  'Calling this tool starts a graceful drain after the current Slack reply is',
  'delivered. The supervisor starts the replacement process, and the next turn',
  'you experience will be a synthetic post-restart trigger (delivered as a',
  '`<system-reminder>`) confirming the restart completed. Keep your user-facing',
  'reply brief — one sentence acknowledging the restart — then stop.',
].join('\n');

export function runRestartHarnessTool(
  ctx: RestartHarnessContext,
  input: RestartHarnessInput,
): RestartHarnessToolResult {
  const info: PendingRestart = {
    sessionKey: ctx.sessionKey,
    channelId: ctx.channelId,
    threadTs: ctx.threadTs,
    reason: input.reason,
    requestedAt: Date.now(),
  };

  const result = ctx.runtimeController.requestRestart(() => {
    const pending = recordPendingRestart(info);
    if (pending.ok) return undefined;
    return {
      code: 'restart_rate_limited',
      message: `Restart rate limited; retry in ${Math.ceil(pending.remainingMs / 1000)}s.`,
    };
  });
  if (!result.ok) {
    return {
      content: [
        {
          type: 'text',
          text: `Restart refused: ${result.message}`,
        },
      ],
      isError: true,
    };
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

const RESTART_HARNESS_INPUT_SCHEMA = {
  reason: z
    .string()
    .describe('Short human-readable reason for the restart, surfaced back to you in the post-restart notice.')
    .optional(),
};

export function createRestartHarnessToolSpec(ctx: RestartHarnessContext): AgentToolSpec {
  return {
    name: RESTART_HARNESS_TOOL_NAME,
    label: 'Restart harness',
    description: RESTART_HARNESS_DESCRIPTION,
    inputSchema: RESTART_HARNESS_INPUT_SCHEMA,
    async execute(input) {
      const result = runRestartHarnessTool(ctx, input as RestartHarnessInput);
      if (result.isError) {
        return result;
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
