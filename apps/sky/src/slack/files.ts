import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DOWNLOAD_DIR = path.join(os.tmpdir(), 'sky');

export type SlackFile = {
  id: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  url_private?: string;
  url_private_download?: string;
};

export type DownloadedFile = {
  originalName: string;
  localPath: string;
};

export type SlackFileUploadResult = {
  path: string;
  fileId?: string;
};

export type SlackFileUploadFailure = {
  path: string;
  reason: string;
};

export type SlackFileUploadParams = {
  channelId: string;
  threadTs: string;
  paths: string[];
};

export type SlackFileUploader = {
  uploadFiles(params: SlackFileUploadParams): Promise<SlackFileUploadResult[]>;
};

export class SlackFileUploadError extends Error {
  constructor(
    message: string,
    readonly successes: SlackFileUploadResult[],
    readonly failures: SlackFileUploadFailure[],
  ) {
    super(message);
    this.name = 'SlackFileUploadError';
  }
}

export type SlackUploadV2Client = {
  files: {
    uploadV2(params: {
      file: ReturnType<typeof createReadStream>;
      filename: string;
      channel_id: string;
      thread_ts: string;
    }): Promise<unknown>;
  };
};

function ensureDownloadDir(): void {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function uniquePath(name: string): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  const stamp = Date.now().toString(36);
  return path.join(DOWNLOAD_DIR, `${sanitizeFilename(base)}-${stamp}${ext}`);
}

async function downloadFile(url: string, token: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function downloadSlackFiles(
  files: SlackFile[],
  client: { token?: string },
): Promise<DownloadedFile[]> {
  ensureDownloadDir();

  const token = client.token;
  if (!token) {
    console.error('[slack:files] no bot token available for file download');
    return [];
  }

  const results: DownloadedFile[] = [];

  for (const file of files) {
    const url = file.url_private_download ?? file.url_private;
    if (!url) {
      console.warn(`[slack:files] skipping file ${file.id}: no download URL`);
      continue;
    }

    const originalName = file.name ?? `file-${file.id}`;
    const localPath = uniquePath(originalName);

    try {
      const data = await downloadFile(url, token);
      writeFileSync(localPath, data);
      results.push({ originalName, localPath });
      console.log(`[slack:files] downloaded ${originalName} -> ${localPath} (${data.length} bytes)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[slack:files] failed to download ${originalName}: ${message}`);
    }
  }

  return results;
}

export function formatAttachmentsLine(downloaded: DownloadedFile[]): string {
  if (downloaded.length === 0) return '';
  const paths = downloaded.map((f) => `\`${f.localPath}\``).join(', ');
  return `Attachments: ${paths}`;
}

export function createSlackFileUploader(client: SlackUploadV2Client): SlackFileUploader {
  return {
    async uploadFiles({ channelId, threadTs, paths }) {
      const successes: SlackFileUploadResult[] = [];
      const failures: SlackFileUploadFailure[] = [];

      for (const localPath of paths) {
        try {
          const response = await client.files.uploadV2({
            file: createReadStream(localPath),
            filename: path.basename(localPath),
            channel_id: channelId,
            thread_ts: threadTs,
          });
          successes.push({ path: localPath, fileId: readUploadedFileId(response) });
        } catch (error) {
          failures.push({ path: localPath, reason: errorMessage(error) });
        }
      }

      if (failures.length > 0) {
        throw new SlackFileUploadError('One or more Slack file uploads failed.', successes, failures);
      }

      return successes;
    },
  };
}

function readUploadedFileId(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;

  const file = 'file' in response ? response.file : undefined;
  if (file && typeof file === 'object' && 'id' in file && typeof file.id === 'string') {
    return file.id;
  }

  const files = 'files' in response ? response.files : undefined;
  if (Array.isArray(files)) {
    const first = files[0] as unknown;
    if (first && typeof first === 'object' && 'id' in first && typeof first.id === 'string') {
      return first.id;
    }
  }

  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
