import path from 'node:path';
import {
  query as claudeQuery,
  type AccountInfo,
  type Query as ClaudeQuery,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  ModelRuntime as PiModelRuntime,
  readStoredCredential,
} from '@earendil-works/pi-coding-agent';
import type {
  Configuration,
  PublicSettings,
  SecretName,
} from './configuration.js';

export const REQUIRED_SLACK_BOT_SCOPES = [
  'app_mentions.read',
  'channels:history',
  'chat:write',
  'files:write',
  'groups:history',
  'im:history',
  'reactions:write',
] as const;

export type ConnectionTarget = 'slack.bot' | 'slack.app' | 'agent';

export type ConnectionCheckStatus =
  | 'ok'
  | 'not_configured'
  | 'invalid_credential'
  | 'timeout'
  | 'rate_limited'
  | 'missing_scope'
  | 'unavailable'
  | 'invalid_configuration'
  | 'model_not_found'
  | 'credential_missing'
  | 'effort_unsupported';

export type ConnectionCheck = {
  target: ConnectionTarget;
  status: ConnectionCheckStatus;
  checkedAt: string;
  summary: string;
  details: {
    workspace?: { id: string | null; name: string | null };
    bot?: { id: string | null; userId: string | null; name: string | null };
    grantedScopes?: string[];
    missingScopes?: string[];
    retryAfterSeconds?: number | null;
    account?: {
      email: string | null;
      organization: string | null;
      subscriptionType: string | null;
      tokenSource: string | null;
      apiProvider: AccountInfo['apiProvider'] | null;
    };
    backend?: {
      name: PublicSettings['agentBackend'];
      provider: string | null;
      model: string | null;
      effort: PublicSettings['effort'];
      credentialSource: string | null;
    };
  };
};

export type ConnectionsSnapshot = {
  schemaVersion: 1;
  checks: Record<ConnectionTarget, ConnectionCheck | null>;
};

export type Connections = {
  get(): ConnectionsSnapshot;
  check(target: ConnectionTarget): Promise<ConnectionsSnapshot>;
  invalidate(target: ConnectionTarget): void;
};

type SlackResponse = {
  status: number;
  headers: Headers;
  json(): Promise<unknown>;
};

export type ConnectionsOptions = {
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<SlackResponse>;
  claudeAccountInfo?: (input: {
    token: string;
    workspace: string;
    timeoutMs: number;
  }) => Promise<AccountInfo>;
  homeDir: string;
  now?: () => Date;
  timeoutMs?: number;
};

type SlackPayload = {
  ok?: unknown;
  error?: unknown;
  team?: unknown;
  team_id?: unknown;
  user?: unknown;
  user_id?: unknown;
  bot_id?: unknown;
  url?: unknown;
};

type PiRuntimeOptions = NonNullable<Parameters<typeof PiModelRuntime.create>[0]>;

export type PiBackendInspection = {
  provider: string;
  model: string;
  modelFound: boolean;
  credentialConfigured: boolean;
  credentialSource: string | null;
  effortCompatible: boolean;
};

class ProbeFailure extends Error {
  constructor(
    readonly status: Extract<
      ConnectionCheckStatus,
      'invalid_credential' | 'timeout' | 'rate_limited' | 'missing_scope' | 'unavailable'
    >,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(status);
  }
}

function normalizeProbeFailure(error: unknown): ProbeFailure {
  if (error instanceof ProbeFailure) return error;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new ProbeFailure('timeout');
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('rate limit') || message.includes('rate_limit')) {
    return new ProbeFailure('rate_limited');
  }
  if (
    message.includes('auth') ||
    message.includes('oauth') ||
    message.includes('credential') ||
    message.includes('token') ||
    message.includes('login')
  ) {
    return new ProbeFailure('invalid_credential');
  }
  return new ProbeFailure('unavailable');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProbeFailure('timeout')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function externalString(value: unknown, protectedValue: string): string | null {
  const parsed = stringOrNull(value);
  return parsed && !parsed.includes(protectedValue) ? parsed : null;
}

function parseScopes(value: string | null): string[] | undefined {
  if (value === null) return undefined;
  return [
    ...new Set(
      value
        .split(',')
        .map((scope) => scope.trim())
        .filter((scope) => /^[a-z][a-z0-9_.:-]*$/.test(scope)),
    ),
  ];
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function slackFailure(
  response: SlackResponse,
  payload: SlackPayload,
): ProbeFailure | undefined {
  const error = stringOrNull(payload.error);
  if (response.status === 429 || error === 'ratelimited') {
    return new ProbeFailure('rate_limited', parseRetryAfter(response.headers.get('retry-after')));
  }
  if (
    error === 'invalid_auth' ||
    error === 'not_authed' ||
    error === 'account_inactive' ||
    error === 'token_expired' ||
    error === 'token_revoked' ||
    error === 'not_allowed_token_type'
  ) {
    return new ProbeFailure('invalid_credential');
  }
  if (error === 'missing_scope') return new ProbeFailure('missing_scope');
  if (payload.ok !== true || response.status < 200 || response.status >= 300) {
    return new ProbeFailure('unavailable');
  }
  return undefined;
}

async function slackCall(
  fetcher: NonNullable<ConnectionsOptions['fetch']>,
  method: 'auth.test' | 'apps.connections.open',
  token: string,
  timeoutMs: number,
): Promise<{ response: SlackResponse; payload: SlackPayload }> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetcher(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: '',
      signal: abortController.signal,
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProbeFailure('unavailable');
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ProbeFailure('unavailable');
    }
    const typedPayload = payload as SlackPayload;
    const failure = slackFailure(response, typedPayload);
    if (failure) throw failure;
    return { response, payload: typedPayload };
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    if (
      abortController.signal.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
    ) {
      throw new ProbeFailure('timeout');
    }
    throw new ProbeFailure('unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

function pendingInput(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          signal.aborted
            ? Promise.resolve({ value: undefined, done: true } as IteratorResult<SDKUserMessage>)
            : new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
                signal.addEventListener(
                  'abort',
                  () => resolve({ value: undefined, done: true }),
                  { once: true },
                );
              }),
      };
    },
  };
}

function claudeEnvironment(token: string): Record<string, string | undefined> {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'sky/connections',
  };
}

async function defaultClaudeAccountInfo(input: {
  token: string;
  workspace: string;
  timeoutMs: number;
}): Promise<AccountInfo> {
  const abortController = new AbortController();
  let query: ClaudeQuery | undefined;
  const timeout = setTimeout(() => abortController.abort(), input.timeoutMs);
  timeout.unref?.();
  try {
    query = claudeQuery({
      prompt: pendingInput(abortController.signal),
      options: {
        abortController,
        cwd: input.workspace,
        env: claudeEnvironment(input.token),
        settingSources: [],
        settings: { disableBundledSkills: true },
        tools: [],
        persistSession: false,
      },
    });
    return await query.accountInfo();
  } catch (error) {
    if (
      abortController.signal.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
    ) {
      throw new ProbeFailure('timeout');
    }
    throw normalizeProbeFailure(error);
  } finally {
    clearTimeout(timeout);
    abortController.abort();
    query?.close();
  }
}

function checkResult(
  target: ConnectionTarget,
  status: ConnectionCheckStatus,
  checkedAt: string,
  summary: string,
  details: ConnectionCheck['details'] = {},
): ConnectionCheck {
  return { target, status, checkedAt, summary, details };
}

function failureResult(
  target: ConnectionTarget,
  error: unknown,
  checkedAt: string,
): ConnectionCheck {
  const failure = normalizeProbeFailure(error);
  const summary = {
    invalid_credential: 'The credential was rejected.',
    timeout: 'The connection check timed out.',
    rate_limited: 'The external service rate-limited the check.',
    missing_scope: 'The credential is missing a required scope.',
    unavailable: 'The external service could not be reached.',
  }[failure.status];
  return checkResult(
    target,
    failure.status,
    checkedAt,
    summary,
    failure.status === 'rate_limited'
      ? { retryAfterSeconds: failure.retryAfterSeconds }
      : {},
  );
}

export async function inspectPiBackend(
  settings: PublicSettings,
  homeDir: string,
): Promise<PiBackendInspection> {
  const model = settings.model ?? '';
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error('invalid_model');
  }
  const provider = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  const agentDir = path.join(homeDir, '.pi', 'agent');
  let storedCredential = readStoredCredential(provider, path.join(agentDir, 'auth.json'));
  const credentials: NonNullable<PiRuntimeOptions['credentials']> = {
    async read(providerId) {
      return providerId === provider ? storedCredential : undefined;
    },
    async list() {
      return storedCredential ? [{ providerId: provider, type: storedCredential.type }] : [];
    },
    async modify(providerId, update) {
      const current = providerId === provider ? storedCredential : undefined;
      const next = await update(current);
      if (providerId === provider) storedCredential = next;
      return next;
    },
    async delete(providerId) {
      if (providerId === provider) storedCredential = undefined;
    },
  };
  const modelsStore: NonNullable<PiRuntimeOptions['modelsStore']> = {
    async read() {
      return undefined;
    },
    async write() {},
    async delete() {},
  };
  const runtime = await PiModelRuntime.create({
    credentials,
    modelsPath: path.join(agentDir, 'models.json'),
    modelsStore,
    allowModelNetwork: false,
  });
  const registryModel = runtime.getModel(provider, modelId);
  const auth = runtime.getProviderAuthStatus(provider);
  return {
    provider,
    model,
    modelFound: registryModel !== undefined,
    credentialConfigured: auth.configured,
    credentialSource: auth.source ?? null,
    effortCompatible: !settings.effort || registryModel?.reasoning === true,
  };
}

function secretTarget(name: SecretName): ConnectionTarget {
  return name === 'slack.botToken'
    ? 'slack.bot'
    : name === 'slack.appToken'
      ? 'slack.app'
      : 'agent';
}

function notConfigured(
  target: ConnectionTarget,
  checkedAt: string,
): ConnectionCheck {
  return checkResult(target, 'not_configured', checkedAt, 'No credential is configured.');
}

export function createConnections(
  configuration: Configuration,
  options: ConnectionsOptions,
): Connections {
  const fetcher = options.fetch ?? fetch;
  const accountInfo = options.claudeAccountInfo ?? defaultClaudeAccountInfo;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 8_000;
  const checks: Record<ConnectionTarget, ConnectionCheck | null> = {
    'slack.bot': null,
    'slack.app': null,
    agent: null,
  };
  const snapshot = (): ConnectionsSnapshot => ({
    schemaVersion: 1,
    checks: {
      'slack.bot': checks['slack.bot'] ? structuredClone(checks['slack.bot']) : null,
      'slack.app': checks['slack.app'] ? structuredClone(checks['slack.app']) : null,
      agent: checks.agent ? structuredClone(checks.agent) : null,
    },
  });

  const checkSlackBot = async (checkedAt: string): Promise<ConnectionCheck> => {
    const credential = configuration.resolveSecret('slack.botToken');
    if (credential.value === undefined) return notConfigured('slack.bot', checkedAt);
    try {
      const { response, payload } = await slackCall(
        fetcher,
        'auth.test',
        credential.value,
        timeoutMs,
      );
      const grantedScopes = parseScopes(response.headers.get('x-oauth-scopes'));
      if (!grantedScopes) {
        return checkResult(
          'slack.bot',
          'unavailable',
          checkedAt,
          'Slack authenticated the bot, but did not report its granted scopes.',
        );
      }
      const granted = new Set(grantedScopes);
      const missingScopes = REQUIRED_SLACK_BOT_SCOPES.filter((scope) => !granted.has(scope));
      return checkResult(
        'slack.bot',
        missingScopes.length === 0 ? 'ok' : 'missing_scope',
        checkedAt,
        missingScopes.length === 0
          ? 'Slack bot authentication and required scopes are valid.'
          : 'Slack bot authentication succeeded, but required scopes are missing.',
        {
          workspace: {
            id: externalString(payload.team_id, credential.value),
            name: externalString(payload.team, credential.value),
          },
          bot: {
            id: externalString(payload.bot_id, credential.value),
            userId: externalString(payload.user_id, credential.value),
            name: externalString(payload.user, credential.value),
          },
          grantedScopes,
          missingScopes: [...missingScopes],
        },
      );
    } catch (error) {
      return failureResult('slack.bot', error, checkedAt);
    }
  };

  const checkSlackApp = async (checkedAt: string): Promise<ConnectionCheck> => {
    const credential = configuration.resolveSecret('slack.appToken');
    if (credential.value === undefined) return notConfigured('slack.app', checkedAt);
    try {
      const { payload } = await slackCall(
        fetcher,
        'apps.connections.open',
        credential.value,
        timeoutMs,
      );
      if (typeof payload.url !== 'string' || !payload.url.startsWith('wss://')) {
        return checkResult(
          'slack.app',
          'unavailable',
          checkedAt,
          'Slack did not return a usable Socket Mode connection.',
        );
      }
      return checkResult(
        'slack.app',
        'ok',
        checkedAt,
        'Slack accepted the app token for Socket Mode.',
      );
    } catch (error) {
      return failureResult('slack.app', error, checkedAt);
    }
  };

  const checkAgent = async (checkedAt: string): Promise<ConnectionCheck> => {
    const settings = configuration.inspect().public.settings;
    if (settings.agentBackend === 'pi') {
      try {
        const inspection = await inspectPiBackend(settings, options.homeDir);
        const details: ConnectionCheck['details'] = {
          backend: {
            name: 'pi',
            provider: inspection.provider,
            model: inspection.model,
            effort: settings.effort,
            credentialSource: inspection.credentialSource,
          },
        };
        if (!inspection.modelFound) {
          return checkResult(
            'agent',
            'model_not_found',
            checkedAt,
            'The selected model is not present in the local Pi registry.',
            details,
          );
        }
        if (!inspection.credentialConfigured) {
          return checkResult(
            'agent',
            'credential_missing',
            checkedAt,
            'No provider credential is configured for the selected Pi model.',
            details,
          );
        }
        if (!inspection.effortCompatible) {
          return checkResult(
            'agent',
            'effort_unsupported',
            checkedAt,
            'The selected Pi model does not support the configured effort level.',
            details,
          );
        }
        return checkResult(
          'agent',
          'ok',
          checkedAt,
          'The Pi model, provider credential, and effort are compatible.',
          details,
        );
      } catch {
        return checkResult(
          'agent',
          'invalid_configuration',
          checkedAt,
          'The local Pi model configuration could not be inspected.',
        );
      }
    }

    const credential = configuration.resolveSecret('claudeAgentSdk.oauthToken');
    if (credential.value === undefined) return notConfigured('agent', checkedAt);
    if (!settings.model?.startsWith('anthropic/')) {
      return checkResult(
        'agent',
        'invalid_configuration',
        checkedAt,
        'Claude Agent SDK requires an anthropic/model selection.',
      );
    }
    try {
      const account = await withTimeout(
        accountInfo({
          token: credential.value,
          workspace: settings.workspace,
          timeoutMs,
        }),
        timeoutMs,
      );
      return checkResult(
        'agent',
        'ok',
        checkedAt,
        'Claude Agent SDK authentication is valid.',
        {
          account: {
            email: externalString(account.email, credential.value),
            organization: externalString(account.organization, credential.value),
            subscriptionType: externalString(account.subscriptionType, credential.value),
            tokenSource: externalString(account.tokenSource, credential.value),
            apiProvider: account.apiProvider ?? null,
          },
          backend: {
            name: 'claude-agent-sdk',
            provider: 'anthropic',
            model: settings.model,
            effort: settings.effort,
            credentialSource: credential.source,
          },
        },
      );
    } catch (error) {
      return failureResult('agent', error, checkedAt);
    }
  };

  return {
    get: snapshot,
    async check(target) {
      const checkedAt = now().toISOString();
      checks[target] =
        target === 'slack.bot'
          ? await checkSlackBot(checkedAt)
          : target === 'slack.app'
            ? await checkSlackApp(checkedAt)
            : await checkAgent(checkedAt);
      return snapshot();
    },
    invalidate(target) {
      checks[target] = null;
    },
  };
}

export function connectionTargetForSecret(name: SecretName): ConnectionTarget {
  return secretTarget(name);
}
