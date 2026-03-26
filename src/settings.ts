import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const CLAUDECLAW_DIR = path.join(os.homedir(), '.claudeclaw');
const SETTINGS_FILE = path.join(CLAUDECLAW_DIR, 'settings.json');

const settingsSchema = z.object({
  telegram: z.object({
    botToken: z.string(),
  }),
  slack: z
    .object({
      botToken: z.string(),
      appToken: z.string(),
    })
    .optional(),
  claude: z
    .object({
      model: z.string().default('sonnet'),
    })
    .default({ model: 'sonnet' }),
  workspace: z.string().default(path.join(os.homedir(), '.claudeclaw', 'workspace')),
});

export type Settings = z.infer<typeof settingsSchema>;

export function loadSettings(): Settings {
  console.log(`[startup] reading ${SETTINGS_FILE}`);
  try {
    const raw = readFileSync(SETTINGS_FILE, 'utf8');
    return settingsSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Settings file not found: ${SETTINGS_FILE}\nCreate it with at least: { "telegram": { "botToken": "..." } }`);
    }
    throw error;
  }
}
