import { z } from 'zod';
import { AGENT_EFFORT_LEVELS } from './agents/effort.js';
import { createSkyHome } from './sky-home.js';

const slackSettingsSchema = z.object({
  botToken: z.string(),
  appToken: z.string(),
});

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
