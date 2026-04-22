import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { requestRestart, type PendingRestart } from '../../runtime/pending-restart.js';

/**
 * MCP tool name suffix. The full name exposed to the allowlist is
 * `mcp__<server>__<tool>`, i.e. `mcp__joy__restart_harness`.
 */
export const RESTART_HARNESS_SERVER_NAME = 'joy';
export const RESTART_HARNESS_TOOL_NAME = 'restart_harness';
export const RESTART_HARNESS_FQ_TOOL_NAME = `mcp__${RESTART_HARNESS_SERVER_NAME}__${RESTART_HARNESS_TOOL_NAME}`;

/**
 * Everything the tool needs captured in closure when the factory runs. The
 * bot wires a fresh server per session so each tool call is scoped to the
 * session that invoked it — no need for runtime context resolution.
 */
export type RestartHarnessContext = {
  /** Session key used by the session manager (e.g. `"C123:1234.5678"`). */
  sessionKey: string;
  /** Slack channel id for post-restart delivery. */
  channelId: string;
  /** Slack thread ts for post-restart delivery. */
  threadTs: string;
  /**
   * Called by the tool handler **after** a successful `requestRestart()`.
   * The bot schedules the self-restart (spawn replacement + SIGTERM) on a
   * short delay so the in-flight assistant turn can flush its final message
   * to Slack first.
   */
  scheduleRestart: () => void;
};

const TOOL_DESCRIPTION = [
  'Restart the joy harness (this very process).',
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

const InputSchema = {
  reason: z
    .string()
    .optional()
    .describe(
      'Short human-readable reason for the restart, surfaced back to you in the post-restart notice.',
    ),
};

/**
 * Create an in-process MCP server exposing the `restart_harness` tool bound
 * to a specific session. Call this once per session open.
 */
export function createRestartHarnessServer(
  ctx: RestartHarnessContext,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: RESTART_HARNESS_SERVER_NAME,
    version: '1.0.0',
    tools: [
      tool(RESTART_HARNESS_TOOL_NAME, TOOL_DESCRIPTION, InputSchema, async ({ reason }) => {
        const info: PendingRestart = {
          sessionKey: ctx.sessionKey,
          channelId: ctx.channelId,
          threadTs: ctx.threadTs,
          reason,
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

        ctx.scheduleRestart();

        return {
          content: [
            {
              type: 'text',
              text: 'Restart scheduled. Inform 태영님 briefly that the harness is restarting, then stop — the post-restart trigger will arrive shortly.',
            },
          ],
        };
      }),
    ],
  });
}
