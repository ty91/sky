import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AGENT_EFFORT_LEVELS } from './agents/effort.js';
import { createSkyHome, type SkyHome } from './sky-home.js';

const slackSettingsSchema = z.object({
  botToken: z.string(),
  appToken: z.string(),
});

// Credentials for the `claude-agent-sdk` backend. Kept here (in addition to any
// `CLAUDE_CODE_OAUTH_TOKEN` env var) so headless cron runs — which do NOT source
// ~/.zshrc — can still authenticate. An explicit env var, when present, wins.
const claudeAgentSdkSettingsSchema = z.object({
  oauthToken: z.string().min(1),
});

function createSettingsSchema(defaultWorkspace: string) {
  return z
    .object({
      slack: slackSettingsSchema,
      model: z.string().min(1),
      agentBackend: z.enum(['pi', 'claude-agent-sdk']).default('pi'),
      claudeAgentSdk: claudeAgentSdkSettingsSchema.optional(),
      effort: z.enum(AGENT_EFFORT_LEVELS).optional(),
      workspace: z.string().default(defaultWorkspace),
    })
    .strict();
}

export type Settings = z.infer<ReturnType<typeof createSettingsSchema>>;

export function parseSettings(
  raw: unknown,
  options: { defaultWorkspace?: string } = {},
): Settings {
  const defaultWorkspace = options.defaultWorkspace ?? createSkyHome().workspaceDir;
  return createSettingsSchema(defaultWorkspace).parse(raw);
}

export function loadSettings(
  options: { silent?: boolean; skyHome?: SkyHome } = {},
): Settings {
  const home = options.skyHome ?? createSkyHome();
  if (!options.silent) {
    console.log(`[startup] reading ${home.settingsFile}`);
  }
  try {
    const raw = readFileSync(home.settingsFile, 'utf8');
    return parseSettings(JSON.parse(raw), { defaultWorkspace: home.workspaceDir });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        `Settings file not found: ${home.settingsFile}\n` +
          'Create it with Slack settings and a Pi model, for example: ' +
          '{ "slack": { "botToken": "...", "appToken": "..." }, "model": "anthropic/claude-opus-4-7" }',
        { cause: error },
      );
    }
    throw error;
  }
}
