import { chmodSync, lstatSync, readFileSync } from 'node:fs';
import { parseSettings, type Settings } from '../settings.js';

export type ConfigurationErrorCode =
  | 'settings_missing'
  | 'settings_unsafe'
  | 'settings_invalid';

export class ConfigurationError extends Error {
  readonly code: ConfigurationErrorCode;

  constructor(code: ConfigurationErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ConfigurationError';
    this.code = code;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function loadSecureSettings(settingsFile: string): Settings {
  let stats;
  try {
    stats = lstatSync(settingsFile);
  } catch (error) {
    if (isMissing(error)) {
      throw new ConfigurationError('settings_missing', 'Settings file is missing.', error);
    }
    throw new ConfigurationError('settings_invalid', 'Settings file cannot be inspected.', error);
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ConfigurationError(
      'settings_unsafe',
      'Settings must be a regular file owned by the current user.',
    );
  }
  if (process.getuid && stats.uid !== process.getuid()) {
    throw new ConfigurationError(
      'settings_unsafe',
      'Settings must be owned by the current user.',
    );
  }

  try {
    chmodSync(settingsFile, 0o600);
    return parseSettings(JSON.parse(readFileSync(settingsFile, 'utf8')));
  } catch (error) {
    throw new ConfigurationError('settings_invalid', 'Settings are not valid.', error);
  }
}
