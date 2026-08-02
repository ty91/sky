import { readFileSync } from 'node:fs';
import { parseSettings, type Settings } from '../settings.js';
import {
  ensurePrivateFile,
  UnsafeSkyPathError,
  type SkyHome,
} from '../sky-home.js';

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

export function loadSecureSettings(home: SkyHome): Settings {
  const settingsFile = home.settingsFile;
  try {
    if (!ensurePrivateFile(settingsFile)) {
      throw new ConfigurationError('settings_missing', 'Settings file is missing.');
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof UnsafeSkyPathError) {
      throw new ConfigurationError('settings_unsafe', 'Settings file is unsafe.', error);
    }
    throw new ConfigurationError('settings_invalid', 'Settings file cannot be inspected.', error);
  }

  try {
    return parseSettings(JSON.parse(readFileSync(settingsFile, 'utf8')), {
      defaultWorkspace: home.workspaceDir,
    });
  } catch (error) {
    throw new ConfigurationError('settings_invalid', 'Settings are not valid.', error);
  }
}
