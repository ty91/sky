import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const TEMPLATES = {
  'SOUL.md': `# Soul

You are a thoughtful, reliable assistant. Be honest about uncertainty and protect private data.
`,
  'AGENTS.md': `# Agent instructions

- Follow the user's explicit instructions and preserve existing workspace files.
- Ask before destructive or externally visible actions.
- Never reveal secrets or credentials from this workspace.
`,
  'USER.md': `# User

Add stable preferences and working context here.
`,
  'MEMORY.md': `# Memory

Record concise, durable facts that will be useful in future conversations.
`,
} as const;

export type WorkspaceBootstrapResult = {
  workspace: string;
  createdDirectory: boolean;
  createdFiles: string[];
  preservedFiles: string[];
};

export class WorkspaceBootstrapError extends Error {
  readonly code = 'workspace_invalid' as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'WorkspaceBootstrapError';
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function resolveWorkspace(requested: string): { directory: string; created: boolean } {
  if (!requested || !path.isAbsolute(requested) || requested.includes('\0')) {
    throw new WorkspaceBootstrapError('Workspace must be a non-empty absolute path.');
  }

  try {
    const entry = lstatSync(requested);
    if (entry.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = realpathSync(requested);
      } catch (error) {
        throw new WorkspaceBootstrapError(
          'Workspace symlink is broken or cyclic.',
          error,
        );
      }
      if (!statSync(resolved).isDirectory()) {
        throw new WorkspaceBootstrapError('Workspace symlink must resolve to a directory.');
      }
      return { directory: resolved, created: false };
    }
    if (!entry.isDirectory()) {
      throw new WorkspaceBootstrapError('Workspace must be a directory.');
    }
    return { directory: requested, created: false };
  } catch (error) {
    if (error instanceof WorkspaceBootstrapError) throw error;
    if (!isMissing(error)) {
      throw new WorkspaceBootstrapError('Workspace cannot be inspected safely.', error);
    }
  }

  try {
    mkdirSync(requested, { recursive: true, mode: 0o700 });
    if (!lstatSync(requested).isDirectory()) {
      throw new WorkspaceBootstrapError('Workspace could not be created as a directory.');
    }
    return { directory: requested, created: true };
  } catch (error) {
    if (error instanceof WorkspaceBootstrapError) throw error;
    throw new WorkspaceBootstrapError('Workspace could not be created.', error);
  }
}

export function bootstrapWorkspace(requested: string): WorkspaceBootstrapResult {
  const { directory, created } = resolveWorkspace(requested);
  const createdFiles: string[] = [];
  const preservedFiles: string[] = [];

  for (const [name, contents] of Object.entries(TEMPLATES)) {
    const file = path.join(directory, name);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        file,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, contents, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      createdFiles.push(name);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        preservedFiles.push(name);
        continue;
      }
      throw new WorkspaceBootstrapError(`Could not create ${name}.`, error);
    }
  }

  return {
    workspace: directory,
    createdDirectory: created,
    createdFiles,
    preservedFiles,
  };
}
