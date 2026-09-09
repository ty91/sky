import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { AgentToolSpec } from '../backend/types.js';
import {
  SlackFileUploadError,
  type SlackFileUploadFailure,
  type SlackFileUploader,
  type SlackFileUploadResult,
} from '../../slack/files.js';

export const SLACK_ATTACH_FILES_TOOL_NAME = 'slack_attach_files';

export type SlackAttachFilesContext = {
  channelId: string;
  threadTs: string;
};

export type SlackAttachFilesInput = {
  paths?: unknown;
};

export type SlackAttachFilesToolDetails = {
  channelId: string;
  threadTs: string;
  uploadedCount: number;
  uploadedPaths: string[];
  uploads: SlackFileUploadResult[];
};

export type SlackAttachFilesToolResult = {
  content: { type: 'text'; text: string }[];
  details: SlackAttachFilesToolDetails;
};

const SLACK_ATTACH_FILES_INPUT_SCHEMA = {
  paths: z.array(z.string()).min(1),
};

export async function runSlackAttachFilesTool(
  ctx: SlackAttachFilesContext,
  input: SlackAttachFilesInput,
  uploader: SlackFileUploader,
): Promise<SlackAttachFilesToolResult> {
  validateContext(ctx);
  const paths = await validateLocalFiles(input.paths);

  try {
    const uploads = await uploader.uploadFiles({
      channelId: ctx.channelId,
      threadTs: ctx.threadTs,
      paths,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Uploaded ${uploads.length} file(s) to Slack: ${uploads.map((upload) => upload.path).join(', ')}`,
        },
      ],
      details: {
        channelId: ctx.channelId,
        threadTs: ctx.threadTs,
        uploadedCount: uploads.length,
        uploadedPaths: uploads.map((upload) => upload.path),
        uploads,
      },
    };
  } catch (error) {
    if (error instanceof SlackFileUploadError) {
      throw new Error(formatUploadFailure(error.successes, error.failures), { cause: error });
    }
    throw error;
  }
}

export function createSlackAttachFilesToolSpec(
  ctx: SlackAttachFilesContext,
  uploader: SlackFileUploader,
): AgentToolSpec {
  return {
    name: SLACK_ATTACH_FILES_TOOL_NAME,
    label: 'Attach Slack files',
    description: [
      'Upload local files to the current Slack thread.',
      'Use only when the user explicitly asks you to attach or share local files.',
      'Provide local filesystem paths only. Do not include comments or titles.',
    ].join('\n'),
    inputSchema: SLACK_ATTACH_FILES_INPUT_SCHEMA,
    async execute(input) {
      return runSlackAttachFilesTool(ctx, input as SlackAttachFilesInput, uploader);
    },
  };
}

async function validateLocalFiles(rawPaths: unknown): Promise<string[]> {
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    throw new Error('paths must include at least one file.');
  }

  const failures: SlackFileUploadFailure[] = [];
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const rawPath of rawPaths) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      failures.push({ path: String(rawPath), reason: 'path must be a non-empty string' });
      continue;
    }

    const filePath = rawPath.trim();
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    deduped.push(filePath);
  }

  for (const filePath of deduped) {
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        failures.push({ path: filePath, reason: 'path is not a regular file' });
        continue;
      }
      await access(filePath, fsConstants.R_OK);
    } catch (error) {
      failures.push({ path: filePath, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  if (failures.length > 0) {
    throw new Error(`File validation failed: ${formatFailures(failures)}`);
  }

  if (deduped.length === 0) {
    throw new Error('paths must include at least one file.');
  }

  return deduped;
}

function validateContext(ctx: SlackAttachFilesContext): void {
  if (!ctx.channelId.trim() || !ctx.threadTs.trim()) {
    throw new Error('Slack file upload is unavailable: missing channelId or threadTs.');
  }
}

function formatUploadFailure(
  successes: SlackFileUploadResult[],
  failures: SlackFileUploadFailure[],
): string {
  const parts = [`Slack file upload failed: ${formatFailures(failures)}`];
  if (successes.length > 0) {
    parts.push(`Uploaded before failure: ${successes.map((success) => success.path).join(', ')}`);
  }
  return parts.join('\n');
}

function formatFailures(failures: SlackFileUploadFailure[]): string {
  return failures.map((failure) => `${failure.path}: ${failure.reason}`).join('; ');
}
