/**
 * Model aliases usable from chat commands (`!model <alias>`).
 *
 * Values are full `provider/model` names because that is what the agent
 * backends expect (`agents/backend/claude.ts` strips the provider prefix).
 * Keeping this an explicit allowlist matters: an unknown model name only fails
 * once a turn actually runs, which would leave the thread permanently broken.
 */
export const MODEL_ALIASES = {
  fable: 'anthropic/claude-fable-5',
  opus: 'anthropic/claude-opus-5',
  sonnet: 'anthropic/claude-sonnet-5',
} as const;

export type ModelAlias = keyof typeof MODEL_ALIASES;

export const MODEL_ALIAS_NAMES = Object.keys(MODEL_ALIASES) as ModelAlias[];

export function resolveModelAlias(alias: string): string | undefined {
  return MODEL_ALIASES[alias.trim().toLowerCase() as ModelAlias];
}

/** Strips the `provider/` prefix for user-facing messages. */
export function toModelDisplayName(model: string): string {
  const slash = model.indexOf('/');
  return slash === -1 ? model : model.slice(slash + 1);
}
