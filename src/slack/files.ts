import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DOWNLOAD_DIR = path.join(os.tmpdir(), 'joy');

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
