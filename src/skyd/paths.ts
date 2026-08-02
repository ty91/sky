import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SkydPaths = {
  skyDir: string;
  runDir: string;
  logsDir: string;
  settingsFile: string;
  socketFile: string;
  logFile: string;
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function ensurePrivateDirectory(directory: string): void {
  try {
    const stats = lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Expected a private directory at ${directory}.`);
    }
    if (process.getuid && stats.uid !== process.getuid()) {
      throw new Error(`Directory is not owned by the current user: ${directory}.`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    mkdirSync(directory, { mode: 0o700 });
  }

  chmodSync(directory, 0o700);
}

export function prepareSkydPaths(homeDir = os.homedir()): SkydPaths {
  const skyDir = path.join(homeDir, '.sky');
  const runDir = path.join(skyDir, 'run');
  const logsDir = path.join(skyDir, 'logs');

  ensurePrivateDirectory(skyDir);
  ensurePrivateDirectory(runDir);
  ensurePrivateDirectory(logsDir);

  return {
    skyDir,
    runDir,
    logsDir,
    settingsFile: path.join(skyDir, 'settings.json'),
    socketFile: path.join(runDir, 'skyd.sock'),
    logFile: path.join(logsDir, 'skyd.jsonl'),
  };
}
