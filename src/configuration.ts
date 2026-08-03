import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AGENT_EFFORT_LEVELS } from './agents/effort.js';
import { parseSettings, type Settings } from './settings-schema.js';
import {
  ensurePrivateFile,
  inspectPrivateFile,
  UnsafeSkyPathError,
  type SkyHome,
} from './sky-home.js';

export const SECRET_NAMES = [
  'slack.botToken',
  'slack.appToken',
  'claudeAgentSdk.oauthToken',
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

export type PublicSettings = {
  agentBackend: 'pi' | 'claude-agent-sdk';
  model: string | null;
  effort: (typeof AGENT_EFFORT_LEVELS)[number] | null;
  workspace: string;
};

export type SecretMetadata = {
  configured: boolean;
  source: 'stored' | 'environment' | null;
  updatedAt: string | null;
  displayHint: string | null;
};

export type PublicConfiguration = {
  schemaVersion: 1;
  revision: number;
  settings: PublicSettings;
  secrets: Record<SecretName, SecretMetadata>;
  complete: boolean;
};

export type ConfigurationInspection = {
  public: PublicConfiguration;
  identity: string;
};

export type RuntimeConfiguration = {
  settings: Settings;
  revision: number;
  identity: string;
};

export type ConfigurationErrorCode =
  | 'settings_missing'
  | 'settings_unsafe'
  | 'settings_invalid'
  | 'settings_version_unsupported'
  | 'secrets_unsafe'
  | 'secrets_invalid'
  | 'migration_conflict'
  | 'revision_conflict'
  | 'unknown_field'
  | 'unknown_secret'
  | 'invalid_value'
  | 'configuration_incomplete';

export class ConfigurationError extends Error {
  constructor(
    readonly code: ConfigurationErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ConfigurationError';
  }
}

const settingsDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    agentBackend: z.enum(['pi', 'claude-agent-sdk']),
    model: z.string().min(1),
    effort: z.enum(AGENT_EFFORT_LEVELS).optional(),
    workspace: z.string().min(1),
  })
  .strict();

type SettingsDocument = z.infer<typeof settingsDocumentSchema>;

type StoredSecret = { value: string; updatedAt: string };
type SecretsDocument = {
  schemaVersion: 1;
  secrets: Partial<Record<SecretName, StoredSecret>>;
};

export type SettingsPatch = Partial<{
  agentBackend: PublicSettings['agentBackend'];
  model: string;
  effort: PublicSettings['effort'];
  workspace: string;
}>;

export type Configuration = {
  inspect(): ConfigurationInspection;
  resolveRuntime(): RuntimeConfiguration;
  patch(expectedRevision: number, patch: SettingsPatch): ConfigurationInspection;
  setSecret(name: SecretName, value: string): ConfigurationInspection;
  deleteSecret(name: SecretName): ConfigurationInspection;
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function translateUnsafe(kind: 'settings' | 'secrets', error: unknown): never {
  if (error instanceof UnsafeSkyPathError) {
    throw new ConfigurationError(
      kind === 'settings' ? 'settings_unsafe' : 'secrets_unsafe',
      `${kind === 'settings' ? 'Settings' : 'Secret storage'} is unsafe.`,
      {},
      error,
    );
  }
  throw error;
}

function readPrivateJson(
  file: string,
  kind: 'settings' | 'secrets',
  repairPermissions = false,
): unknown | undefined {
  try {
    if (!(repairPermissions ? ensurePrivateFile(file) : inspectPrivateFile(file))) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    if (isMissing(error)) return undefined;
    if (error instanceof UnsafeSkyPathError) translateUnsafe(kind, error);
    throw new ConfigurationError(
      kind === 'settings' ? 'settings_invalid' : 'secrets_invalid',
      `${kind === 'settings' ? 'Settings' : 'Secret storage'} is not valid.`,
      {},
      error,
    );
  }
}

function atomicWriteJson(file: string, value: unknown, kind: 'settings' | 'secrets'): void {
  try {
    inspectPrivateFile(file);
  } catch (error) {
    translateUnsafe(kind, error);
  }

  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    if (error instanceof UnsafeSkyPathError) translateUnsafe(kind, error);
    throw new ConfigurationError(
      kind === 'settings' ? 'settings_unsafe' : 'secrets_unsafe',
      `${kind === 'settings' ? 'Settings' : 'Secret storage'} could not be updated safely.`,
      {},
      error,
    );
  }
}

function isSecretName(value: string): value is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(value);
}

function parseSecretsDocument(raw: unknown): SecretsDocument {
  if (raw === undefined) return { schemaVersion: 1, secrets: {} };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigurationError('secrets_invalid', 'Secret storage is not valid.');
  }
  const candidate = raw as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.secrets === null ||
    typeof candidate.secrets !== 'object' ||
    Array.isArray(candidate.secrets) ||
    Object.keys(candidate).some((key) => key !== 'schemaVersion' && key !== 'secrets')
  ) {
    throw new ConfigurationError('secrets_invalid', 'Secret storage is not valid.');
  }
  const secrets: Partial<Record<SecretName, StoredSecret>> = {};
  for (const [name, stored] of Object.entries(candidate.secrets as Record<string, unknown>)) {
    if (
      !isSecretName(name) ||
      stored === null ||
      typeof stored !== 'object' ||
      Array.isArray(stored)
    ) {
      throw new ConfigurationError('secrets_invalid', 'Secret storage is not valid.');
    }
    const entry = stored as Record<string, unknown>;
    if (
      typeof entry.value !== 'string' ||
      entry.value.length === 0 ||
      typeof entry.updatedAt !== 'string' ||
      Object.keys(entry).some((key) => key !== 'value' && key !== 'updatedAt')
    ) {
      throw new ConfigurationError('secrets_invalid', 'Secret storage is not valid.');
    }
    secrets[name] = { value: entry.value, updatedAt: entry.updatedAt };
  }
  return { schemaVersion: 1, secrets };
}

function displayHint(name: SecretName, value: string): string | null {
  const prefix = name === 'slack.botToken' ? 'xoxb-' : name === 'slack.appToken' ? 'xapp-' : null;
  if (!prefix || !value.startsWith(prefix) || value.length < prefix.length + 4) return null;
  return `${prefix}…${value.slice(-4)}`;
}

function assertSecretValue(name: SecretName, value: unknown): asserts value is string {
  const prefix = name === 'slack.botToken' ? 'xoxb-' : name === 'slack.appToken' ? 'xapp-' : null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    (prefix !== null && !value.startsWith(prefix))
  ) {
    throw new ConfigurationError('invalid_value', `The value for ${name} is invalid.`);
  }
}

function settingsFromDocument(document: SettingsDocument, secrets: SecretsDocument): Settings {
  return {
    agentBackend: document.agentBackend,
    model: document.model,
    ...(document.effort ? { effort: document.effort } : {}),
    workspace: document.workspace,
    slack: {
      botToken: secrets.secrets['slack.botToken']?.value ?? '',
      appToken: secrets.secrets['slack.appToken']?.value ?? '',
    },
    ...(secrets.secrets['claudeAgentSdk.oauthToken']
      ? { claudeAgentSdk: { oauthToken: secrets.secrets['claudeAgentSdk.oauthToken'].value } }
      : {}),
  };
}

function runtimeIdentity(settings: Settings, revision: number, environmentOauth?: string): string {
  const { claudeAgentSdk, ...nonClaudeSettings } = settings;
  return createHash('sha256')
    .update(
      JSON.stringify({
        revision,
        settings: nonClaudeSettings,
        effectiveClaudeOauth: environmentOauth ?? claudeAgentSdk?.oauthToken ?? null,
      }),
    )
    .digest('hex');
}

export function createConfiguration(
  home: SkyHome,
  options: { env?: NodeJS.ProcessEnv; now?: () => Date; readOnly?: boolean } = {},
): Configuration {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());

  const loadDocuments = (): { settings?: SettingsDocument; secrets: SecretsDocument } => {
    const rawSettings = readPrivateJson(home.settingsFile, 'settings', !options.readOnly);
    let secrets = parseSecretsDocument(
      readPrivateJson(home.secretsFile, 'secrets', !options.readOnly),
    );
    if (rawSettings === undefined) return { secrets };

    if (
      rawSettings !== null &&
      typeof rawSettings === 'object' &&
      !Array.isArray(rawSettings) &&
      Object.hasOwn(rawSettings, 'schemaVersion')
    ) {
      const version = (rawSettings as Record<string, unknown>).schemaVersion;
      if (version !== 1) {
        throw new ConfigurationError(
          'settings_version_unsupported',
          'The settings schema version is unsupported.',
        );
      }
      const result = settingsDocumentSchema.safeParse(rawSettings);
      if (!result.success) {
        throw new ConfigurationError('settings_invalid', 'Settings are not valid.');
      }
      return { settings: result.data, secrets };
    }

    let legacy: Settings;
    try {
      legacy = parseSettings(rawSettings, { defaultWorkspace: home.workspaceDir });
    } catch (error) {
      throw new ConfigurationError('settings_invalid', 'Settings are not valid.', {}, error);
    }
    const migratedValues: Partial<Record<SecretName, string>> = {
      'slack.botToken': legacy.slack.botToken,
      'slack.appToken': legacy.slack.appToken,
      ...(legacy.claudeAgentSdk?.oauthToken
        ? { 'claudeAgentSdk.oauthToken': legacy.claudeAgentSdk.oauthToken }
        : {}),
    };
    for (const [name, value] of Object.entries(migratedValues) as Array<[SecretName, string]>) {
      const existing = secrets.secrets[name];
      if (existing && existing.value !== value) {
        throw new ConfigurationError(
          'migration_conflict',
          'Legacy credentials conflict with the existing secret store.',
        );
      }
    }
    const migratedAt = now().toISOString();
    let secretsChanged = false;
    for (const [name, value] of Object.entries(migratedValues) as Array<[SecretName, string]>) {
      if (!secrets.secrets[name]) {
        secrets.secrets[name] = { value, updatedAt: migratedAt };
        secretsChanged = true;
      }
    }
    if (secretsChanged && !options.readOnly) atomicWriteJson(home.secretsFile, secrets, 'secrets');
    const settings: SettingsDocument = {
      schemaVersion: 1,
      revision: 1,
      agentBackend: legacy.agentBackend,
      model: legacy.model,
      ...(legacy.effort ? { effort: legacy.effort } : {}),
      workspace: legacy.workspace,
    };
    if (!options.readOnly) atomicWriteJson(home.settingsFile, settings, 'settings');
    return { settings, secrets };
  };

  const inspect = (): ConfigurationInspection => {
    const { settings, secrets } = loadDocuments();
    const publicSettings: PublicSettings = settings
      ? {
          agentBackend: settings.agentBackend,
          model: settings.model,
          effort: settings.effort ?? null,
          workspace: settings.workspace,
        }
      : {
          agentBackend: 'pi',
          model: null,
          effort: null,
          workspace: home.workspaceDir,
        };
    const metadata = Object.fromEntries(
      SECRET_NAMES.map((name) => {
        const environmentValue =
          name === 'claudeAgentSdk.oauthToken' ? env.CLAUDE_CODE_OAUTH_TOKEN : undefined;
        const stored = secrets.secrets[name];
        const effective = environmentValue ?? stored?.value;
        return [
          name,
          {
            configured: effective !== undefined,
            source: environmentValue ? 'environment' : stored ? 'stored' : null,
            updatedAt: environmentValue ? null : stored?.updatedAt ?? null,
            displayHint: effective ? displayHint(name, effective) : null,
          } satisfies SecretMetadata,
        ];
      }),
    ) as Record<SecretName, SecretMetadata>;
    const complete =
      settings !== undefined &&
      metadata['slack.botToken'].configured &&
      metadata['slack.appToken'].configured &&
      (settings.agentBackend !== 'claude-agent-sdk' ||
        metadata['claudeAgentSdk.oauthToken'].configured);
    const runtimeSettings = settings
      ? settingsFromDocument(settings, secrets)
      : {
          agentBackend: publicSettings.agentBackend,
          model: '',
          workspace: publicSettings.workspace,
          slack: { botToken: '', appToken: '' },
        } satisfies Settings;
    return {
      public: {
        schemaVersion: 1,
        revision: settings?.revision ?? 0,
        settings: publicSettings,
        secrets: metadata,
        complete,
      },
      identity: runtimeIdentity(runtimeSettings, settings?.revision ?? 0, env.CLAUDE_CODE_OAUTH_TOKEN),
    };
  };

  return {
    inspect,

    resolveRuntime() {
      const { settings, secrets } = loadDocuments();
      if (!settings) throw new ConfigurationError('settings_missing', 'Settings are missing.');
      const resolved = settingsFromDocument(settings, secrets);
      const metadata = inspect().public.secrets;
      if (
        !metadata['slack.botToken'].configured ||
        !metadata['slack.appToken'].configured ||
        (settings.agentBackend === 'claude-agent-sdk' &&
          !metadata['claudeAgentSdk.oauthToken'].configured)
      ) {
        throw new ConfigurationError(
          'configuration_incomplete',
          'Configuration is incomplete.',
        );
      }
      if (env.CLAUDE_CODE_OAUTH_TOKEN) {
        resolved.claudeAgentSdk = { oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN };
      }
      return {
        settings: resolved,
        revision: settings.revision,
        identity: runtimeIdentity(resolved, settings.revision, env.CLAUDE_CODE_OAUTH_TOKEN),
      };
    },

    patch(expectedRevision, patch) {
      const allowed = new Set(['agentBackend', 'model', 'effort', 'workspace']);
      const unknown = Object.keys(patch).find((key) => !allowed.has(key));
      if (unknown) {
        throw new ConfigurationError('unknown_field', 'The settings patch contains an unknown field.', {
          field: unknown,
        });
      }
      const { settings } = loadDocuments();
      const currentRevision = settings?.revision ?? 0;
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new ConfigurationError('invalid_value', 'expectedRevision is invalid.');
      }
      if (expectedRevision !== currentRevision) {
        throw new ConfigurationError('revision_conflict', 'The configuration revision has changed.', {
          current: inspect().public,
        });
      }
      const current = settings ?? {
        schemaVersion: 1 as const,
        revision: 0,
        agentBackend: 'pi' as const,
        model: '',
        workspace: home.workspaceDir,
      };
      const candidate = {
        ...current,
        ...patch,
        ...(patch.effort === null ? { effort: undefined } : {}),
        schemaVersion: 1 as const,
        revision: currentRevision + 1,
      };
      const parsed = settingsDocumentSchema.safeParse(candidate);
      if (
        !parsed.success ||
        !/^[^/\s]+\/[^/\s]+$/.test(parsed.data.model) ||
        (parsed.data.agentBackend === 'claude-agent-sdk' &&
          !parsed.data.model.startsWith('anthropic/')) ||
        !path.isAbsolute(parsed.data.workspace) ||
        parsed.data.workspace.includes('\0')
      ) {
        throw new ConfigurationError('invalid_value', 'The settings patch is invalid.');
      }
      const unchanged =
        settings !== undefined &&
        settings.agentBackend === parsed.data.agentBackend &&
        settings.model === parsed.data.model &&
        settings.effort === parsed.data.effort &&
        settings.workspace === parsed.data.workspace;
      if (!unchanged) atomicWriteJson(home.settingsFile, parsed.data, 'settings');
      return inspect();
    },

    setSecret(name, value) {
      if (!isSecretName(name)) throw new ConfigurationError('unknown_secret', 'Unknown secret name.');
      assertSecretValue(name, value);
      const secrets = parseSecretsDocument(readPrivateJson(home.secretsFile, 'secrets', true));
      secrets.secrets[name] = { value, updatedAt: now().toISOString() };
      atomicWriteJson(home.secretsFile, secrets, 'secrets');
      return inspect();
    },

    deleteSecret(name) {
      if (!isSecretName(name)) throw new ConfigurationError('unknown_secret', 'Unknown secret name.');
      const secrets = parseSecretsDocument(readPrivateJson(home.secretsFile, 'secrets', true));
      if (secrets.secrets[name]) {
        delete secrets.secrets[name];
        atomicWriteJson(home.secretsFile, secrets, 'secrets');
      }
      return inspect();
    },
  };
}
