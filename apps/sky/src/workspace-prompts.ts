import { lstat, open, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export const MAX_PROMPT_BYTES = 256 * 1024;

export const WORKSPACE_PROMPTS = [
  { role: 'soul', filename: 'SOUL.md' },
  { role: 'agents', filename: 'AGENTS.md' },
  { role: 'user', filename: 'USER.md' },
  { role: 'memory', filename: 'MEMORY.md' },
] as const;

export type WorkspacePromptRole = (typeof WORKSPACE_PROMPTS)[number]['role'];
export type WorkspacePromptStatus =
  | 'available'
  | 'missing'
  | 'unreadable'
  | 'broken_symlink'
  | 'non_file'
  | 'too_large';

export type WorkspacePrompt = {
  role: WorkspacePromptRole;
  filename: (typeof WORKSPACE_PROMPTS)[number]['filename'];
  status: WorkspacePromptStatus;
  entry: {
    exists: boolean;
    type: 'missing' | 'file' | 'symlink' | 'other';
    modifiedAt: string | null;
  };
  target: {
    state: 'file' | 'missing' | 'non_file' | 'unreadable';
    sizeBytes: number | null;
    modifiedAt: string | null;
  };
  content: string | null;
};

export type WorkspacePromptSnapshot = {
  maxContentBytes: number;
  prompts: WorkspacePrompt[];
};

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

function entryType(stats: Awaited<ReturnType<typeof lstat>>): WorkspacePrompt['entry']['type'] {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFile()) return 'file';
  return 'other';
}

function missingPrompt(
  prompt: (typeof WORKSPACE_PROMPTS)[number],
): WorkspacePrompt {
  return {
    ...prompt,
    status: 'missing',
    entry: { exists: false, type: 'missing', modifiedAt: null },
    target: { state: 'missing', sizeBytes: null, modifiedAt: null },
    content: null,
  };
}

async function readPromptBytes(file: FileHandle): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_PROMPT_BYTES + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const result = await file.read(
      buffer,
      bytesRead,
      buffer.length - bytesRead,
      bytesRead,
    );
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  return buffer.subarray(0, bytesRead);
}

async function inspectPrompt(
  workspace: string,
  prompt: (typeof WORKSPACE_PROMPTS)[number],
): Promise<WorkspacePrompt> {
  const promptPath = path.join(workspace, prompt.filename);
  let entryStats: Awaited<ReturnType<typeof lstat>>;
  try {
    entryStats = await lstat(promptPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return missingPrompt(prompt);
    return {
      ...prompt,
      status: 'unreadable',
      entry: { exists: false, type: 'missing', modifiedAt: null },
      target: { state: 'unreadable', sizeBytes: null, modifiedAt: null },
      content: null,
    };
  }

  const entry = {
    exists: true,
    type: entryType(entryStats),
    modifiedAt: entryStats.mtime.toISOString(),
  } as const;

  let targetStats: Awaited<ReturnType<typeof stat>>;
  try {
    targetStats = await stat(promptPath);
  } catch (error) {
    const code = errorCode(error);
    const broken = entry.type === 'symlink' && (code === 'ENOENT' || code === 'ELOOP');
    return {
      ...prompt,
      status: broken ? 'broken_symlink' : 'unreadable',
      entry,
      target: {
        state: broken ? 'missing' : 'unreadable',
        sizeBytes: null,
        modifiedAt: null,
      },
      content: null,
    };
  }

  if (!targetStats.isFile()) {
    return {
      ...prompt,
      status: 'non_file',
      entry,
      target: {
        state: 'non_file',
        sizeBytes: targetStats.size,
        modifiedAt: targetStats.mtime.toISOString(),
      },
      content: null,
    };
  }

  let file: FileHandle | undefined;
  try {
    file = await open(promptPath, 'r');
    const openedStats = await file.stat();
    const target = {
      state: openedStats.isFile() ? 'file' : 'non_file',
      sizeBytes: openedStats.size,
      modifiedAt: openedStats.mtime.toISOString(),
    } as const;
    if (!openedStats.isFile()) {
      return { ...prompt, status: 'non_file', entry, target, content: null };
    }
    if (openedStats.size > MAX_PROMPT_BYTES) {
      return { ...prompt, status: 'too_large', entry, target, content: null };
    }
    const bytes = await readPromptBytes(file);
    if (bytes.length > MAX_PROMPT_BYTES) {
      return {
        ...prompt,
        status: 'too_large',
        entry,
        target: { ...target, sizeBytes: bytes.length },
        content: null,
      };
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ...prompt, status: 'available', entry, target, content };
  } catch {
    return {
      ...prompt,
      status: 'unreadable',
      entry,
      target: {
        state: 'unreadable',
        sizeBytes: targetStats.size,
        modifiedAt: targetStats.mtime.toISOString(),
      },
      content: null,
    };
  } finally {
    await file?.close();
  }
}

export async function inspectWorkspacePrompts(
  workspace: string,
): Promise<WorkspacePromptSnapshot> {
  return {
    maxContentBytes: MAX_PROMPT_BYTES,
    prompts: await Promise.all(WORKSPACE_PROMPTS.map((prompt) => inspectPrompt(workspace, prompt))),
  };
}
