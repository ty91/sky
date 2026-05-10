import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const SKY_DIR = path.join(os.homedir(), '.sky');
const SETTINGS_FILE = path.join(SKY_DIR, 'settings.json');

const slackSettingsSchema = z.object({
  botToken: z.string(),
  appToken: z.string(),
});

const settingsSchema = z
  .object({
    slack: slackSettingsSchema,
    model: z.string().min(1),
    workspace: z.string().default(path.join(os.homedir(), '.sky', 'workspace')),
  })
  .strict();

export type Settings = z.infer<typeof settingsSchema>;

export function parseSettings(raw: unknown): Settings {
  return settingsSchema.parse(raw);
}

export function loadSettings(options: { silent?: boolean } = {}): Settings {
  if (!options.silent) {
    console.log(`[startup] reading ${SETTINGS_FILE}`);
  }
  try {
    const raw = readFileSync(SETTINGS_FILE, 'utf8');
    return parseSettings(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        `Settings file not found: ${SETTINGS_FILE}\n` +
          'Create it with Slack settings and a Pi model, for example: ' +
          '{ "slack": { "botToken": "...", "appToken": "..." }, "model": "anthropic/claude-opus-4-7" }',
        { cause: error },
      );
    }
    throw error;
  }
}
