#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  RESTART_HARNESS_DESCRIPTION,
  RESTART_HARNESS_SERVER_NAME,
  RESTART_HARNESS_TOOL_NAME,
  runRestartHarnessTool,
  type RestartHarnessContext,
} from '../agents/tools/restart-harness.js';

type RestartHarnessEnv = {
  SKY_SESSION_KEY?: string;
  SKY_SLACK_CHANNEL_ID?: string;
  SKY_SLACK_THREAD_TS?: string;
  SKY_PARENT_PID?: string;
};

function requireEnv(env: RestartHarnessEnv, key: keyof RestartHarnessEnv): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required env: ${key}`);
  }
  return value;
}

export function contextFromEnv(env: RestartHarnessEnv = process.env): RestartHarnessContext {
  const parentPidRaw = env.SKY_PARENT_PID;
  let parentPid: number | undefined;
  if (parentPidRaw !== undefined) {
    parentPid = Number(parentPidRaw);
    if (!Number.isInteger(parentPid) || parentPid <= 0) {
      throw new Error(`Invalid SKY_PARENT_PID: ${parentPidRaw}`);
    }
  }

  return {
    sessionKey: requireEnv(env, 'SKY_SESSION_KEY'),
    channelId: requireEnv(env, 'SKY_SLACK_CHANNEL_ID'),
    threadTs: requireEnv(env, 'SKY_SLACK_THREAD_TS'),
    parentPid,
  };
}

export function createRestartHarnessMcpServer(
  ctx: RestartHarnessContext,
  signalParent: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): McpServer {
  const server = new McpServer({
    name: RESTART_HARNESS_SERVER_NAME,
    version: '1.0.0',
  });

  server.registerTool(
    RESTART_HARNESS_TOOL_NAME,
    {
      title: 'Restart harness',
      description: RESTART_HARNESS_DESCRIPTION,
      inputSchema: {
        reason: z
          .string()
          .optional()
          .describe(
            'Short human-readable reason for the restart, surfaced back to you in the post-restart notice.',
          ),
      },
    },
    async ({ reason }) => runRestartHarnessTool(ctx, { reason }, signalParent),
  );

  return server;
}

export async function startRestartHarnessMcpServer(): Promise<void> {
  const server = createRestartHarnessMcpServer(contextFromEnv());
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startRestartHarnessMcpServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
