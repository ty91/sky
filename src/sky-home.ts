import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SkyHome = Readonly<{
  rootDir: string;
  settingsFile: string;
  secretsFile: string;
  runDir: string;
  socketFile: string;
  logsDir: string;
  logFile: string;
  launchdStdoutFile: string;
  launchdStderrFile: string;
  databaseFile: string;
  databaseWalFile: string;
  databaseShmFile: string;
  transcriptsDir: string;
  memoryCursorFile: string;
  workspaceDir: string;
  source: 'default' | 'override';
}>;

export class SkyHomeConfigurationError extends Error {
  readonly code = 'sky_home_invalid' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SkyHomeConfigurationError';
  }
}

export class UnsafeSkyPathError extends Error {
  readonly code = 'unsafe_sky_path' as const;

  constructor(filePath: string, reason: string, cause?: unknown) {
    super(
      `Unsafe Sky path at ${filePath}: ${reason}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'UnsafeSkyPathError';
  }
}

export type CreateSkyHomeOptions = {
  rootDir?: string;
  homeDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
};

function validateRoot(rootDir: string): string {
  if (!rootDir || rootDir.includes('\0') || !path.isAbsolute(rootDir)) {
    throw new SkyHomeConfigurationError(
      'Sky home must be a non-empty absolute path without NUL characters.',
    );
  }
  return path.normalize(rootDir);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function ownedByCurrentUser(uid: number): boolean {
  return process.getuid === undefined || uid === process.getuid();
}

function inspectPrivatePath(
  filePath: string,
  expected: 'directory' | 'file' | 'socket',
): boolean {
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw new UnsafeSkyPathError(filePath, 'the entry cannot be inspected', error);
  }

  const hasExpectedType =
    expected === 'directory'
      ? stats.isDirectory()
      : expected === 'file'
        ? stats.isFile()
        : stats.isSocket();
  if (stats.isSymbolicLink() || !hasExpectedType) {
    throw new UnsafeSkyPathError(filePath, `expected a ${expected}`);
  }
  if (!ownedByCurrentUser(stats.uid)) {
    throw new UnsafeSkyPathError(filePath, 'the entry is not owned by the current user');
  }
  return true;
}

export function ensurePrivateDirectory(directory: string): void {
  if (!inspectPrivatePath(directory, 'directory')) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new UnsafeSkyPathError(directory, 'the directory cannot be created', error);
    }
    inspectPrivatePath(directory, 'directory');
  }
  chmodSync(directory, 0o700);
}

export function inspectPrivateDirectory(directory: string): boolean {
  return inspectPrivatePath(directory, 'directory');
}

export function ensurePrivateFile(filePath: string, create = false): boolean {
  if (!inspectPrivatePath(filePath, 'file')) {
    if (!create) return false;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        filePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      throw new UnsafeSkyPathError(filePath, 'the file cannot be created safely', error);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    inspectPrivatePath(filePath, 'file');
  }
  chmodSync(filePath, 0o600);
  return true;
}

export function inspectPrivateFile(filePath: string): boolean {
  return inspectPrivatePath(filePath, 'file');
}

export function inspectPrivateSocket(socketFile: string): boolean {
  return inspectPrivatePath(socketFile, 'socket');
}

export function ensurePrivateSocket(socketFile: string): boolean {
  if (!inspectPrivateSocket(socketFile)) return false;
  chmodSync(socketFile, 0o600);
  return true;
}

export function secureSqliteFiles(databaseFile: string): void {
  for (const file of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
    ensurePrivateFile(file);
  }
}

export function prepareSqliteDatabase(location: string | SkyHome): string {
  if (location === ':memory:') return location;
  const databaseFile = typeof location === 'string' ? location : location.databaseFile;
  if (typeof location === 'string') {
    mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
  } else {
    ensurePrivateDirectory(location.rootDir);
  }
  ensurePrivateFile(databaseFile);
  return databaseFile;
}

function assertPathSegment(value: string, label: string): void {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('\0') ||
    path.basename(value) !== value
  ) {
    throw new UnsafeSkyPathError(value, `${label} must be a single path segment`);
  }
}

export function transcriptDirectory(home: SkyHome, chatId: string): string {
  assertPathSegment(chatId, 'chat id');
  return path.join(home.transcriptsDir, chatId);
}

export function transcriptFile(home: SkyHome, chatId: string, sessionId: string): string {
  assertPathSegment(sessionId, 'session id');
  return path.join(transcriptDirectory(home, chatId), `${sessionId}.md`);
}

function prepareTranscriptTree(directory: string): void {
  ensurePrivateDirectory(directory);
  for (const entry of readdirSync(directory)) {
    const entryPath = path.join(directory, entry);
    let stats;
    try {
      stats = lstatSync(entryPath);
    } catch (error) {
      throw new UnsafeSkyPathError(entryPath, 'the transcript entry cannot be inspected', error);
    }
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      prepareTranscriptTree(entryPath);
    } else if (stats.isFile() && !stats.isSymbolicLink()) {
      ensurePrivateFile(entryPath);
    } else {
      throw new UnsafeSkyPathError(entryPath, 'expected a transcript directory or regular file');
    }
  }
}

export function prepareSkyHome(home: SkyHome): void {
  ensurePrivateDirectory(home.rootDir);
  ensurePrivateDirectory(home.runDir);
  ensurePrivateDirectory(home.logsDir);
  ensurePrivateDirectory(home.transcriptsDir);
  ensurePrivateDirectory(home.workspaceDir);

  for (const file of [
    home.secretsFile,
    home.databaseFile,
    home.databaseWalFile,
    home.databaseShmFile,
    home.memoryCursorFile,
  ]) {
    ensurePrivateFile(file);
  }
  for (let index = 1; index <= 5; index += 1) {
    ensurePrivateFile(`${home.logFile}.${index}`);
  }
  ensurePrivateFile(home.logFile, true);
  ensurePrivateFile(home.launchdStdoutFile, true);
  ensurePrivateFile(home.launchdStderrFile, true);
  prepareTranscriptTree(home.transcriptsDir);
}

export function createSkyHome(options: CreateSkyHomeOptions = {}): SkyHome {
  const env = options.env ?? process.env;
  const hasEnvironmentOverride = Object.hasOwn(env, 'SKY_HOME');
  const source = options.rootDir !== undefined || hasEnvironmentOverride ? 'override' : 'default';
  const requestedRoot =
    options.rootDir ??
    (hasEnvironmentOverride
      ? env.SKY_HOME ?? ''
      : path.join(options.homeDir ?? os.homedir(), '.sky'));
  const rootDir = validateRoot(requestedRoot);
  const databaseFile = path.join(rootDir, 'sky.db');

  return Object.freeze({
    rootDir,
    settingsFile: path.join(rootDir, 'settings.json'),
    secretsFile: path.join(rootDir, 'secrets.json'),
    runDir: path.join(rootDir, 'run'),
    socketFile: path.join(rootDir, 'run', 'skyd.sock'),
    logsDir: path.join(rootDir, 'logs'),
    logFile: path.join(rootDir, 'logs', 'skyd.jsonl'),
    launchdStdoutFile: path.join(rootDir, 'logs', 'launchd.stdout.log'),
    launchdStderrFile: path.join(rootDir, 'logs', 'launchd.stderr.log'),
    databaseFile,
    databaseWalFile: `${databaseFile}-wal`,
    databaseShmFile: `${databaseFile}-shm`,
    transcriptsDir: path.join(rootDir, 'transcripts'),
    memoryCursorFile: path.join(rootDir, 'memory-cursors.json'),
    workspaceDir: path.join(rootDir, 'workspace'),
    source,
  });
}
