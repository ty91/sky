import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { z } from 'zod';
import { AGENT_EFFORT_LEVELS } from '../agents/effort.js';
import {
  SECRET_NAMES,
  type PublicSettings,
  type SecretName,
  type SettingsPatch,
} from '../configuration.js';
import {
  ControlRequestError,
  deleteSecret,
  getConfiguration,
  getDaemonStatus,
  patchConfiguration,
  putSecret,
  requestDaemonRestart,
} from '../skyd/control-uds.js';
import type { ControlConfiguration } from '../skyd/control.js';
import { createSkyHome } from '../sky-home.js';
import { restartLaunchAgent, ServiceLifecycleError } from '../service/launch-agent.js';
import {
  bootstrapWorkspace,
  WorkspaceBootstrapError,
  type WorkspaceBootstrapResult,
} from '../workspace-bootstrap.js';
import {
  openInBrowser,
  printSlackAppSetupSteps,
  slackManifestReport,
} from './slack-manifest-output.js';

const stdinSchema = z
  .object({
    agentBackend: z.enum(['pi', 'claude-agent-sdk']).optional(),
    backend: z.enum(['pi', 'claude-agent-sdk']).optional(),
    model: z.string().min(1).optional(),
    effort: z.enum(AGENT_EFFORT_LEVELS).nullable().optional(),
    workspace: z.string().min(1).optional(),
    secrets: z
      .object({
        'slack.botToken': z.string().min(1).nullable().optional(),
        'slack.appToken': z.string().min(1).nullable().optional(),
        'claudeAgentSdk.oauthToken': z.string().min(1).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => !(value.agentBackend && value.backend), {
    message: 'Use either agentBackend or backend.',
  });

type InitInput = {
  settings: PublicSettings;
  secretChanges: Partial<Record<SecretName, string | null>>;
};

type RestartResult =
  | { requested: false; outcome: 'not_requested' }
  | { requested: true; outcome: 'restarted'; startupState: string }
  | { requested: true; outcome: 'manual_required'; code: string };

type InitResult = {
  changedNonSecretFields: Array<keyof PublicSettings>;
  secrets: ControlConfiguration['secrets'];
  resultingRevision: number;
  restartRequired: boolean;
  restart: RestartResult;
  workspace: WorkspaceBootstrapResult;
};

class InitError extends Error {
  constructor(readonly code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'InitError';
  }
}

async function readStdinDocument(): Promise<unknown> {
  let contents = '';
  for await (const chunk of stdin) {
    contents += chunk.toString();
    if (Buffer.byteLength(contents) > 64 * 1024) {
      throw new InitError('invalid_input', 'The stdin document is too large.');
    }
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new InitError('invalid_input', 'stdin must contain one valid JSON document.');
  }
}

async function question(prompt: string, defaultValue?: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await readline.question(`${prompt}${suffix}: `)).trim();
    return answer || defaultValue || '';
  } finally {
    readline.close();
  }
}

async function hiddenQuestion(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdin.setRawMode) {
    throw new InitError('tty_required', 'Interactive secret input requires a TTY.');
  }
  stdout.write(`${prompt}: `);
  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        for (const byte of chunk) {
          if (byte === 3) {
            stdin.off('data', onData);
            reject(new InitError('interrupted', 'Initialization was interrupted.'));
            return;
          }
          if (byte === 10 || byte === 13) {
            stdin.off('data', onData);
            stdout.write('\n');
            resolve(value);
            return;
          }
          if (byte === 127 || byte === 8) {
            value = value.slice(0, -1);
            continue;
          }
          value += String.fromCharCode(byte);
        }
      };
      stdin.on('data', onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

async function secretChoice(
  name: SecretName,
  configured: boolean,
  required: boolean,
): Promise<string | null | undefined> {
  if (!configured) {
    if (!required) {
      const action = await question(`${name}: set now? (yes/no)`, 'no');
      if (!/^y(?:es)?$/i.test(action)) return undefined;
    }
    const value = await hiddenQuestion(name);
    if (!value) throw new InitError('invalid_input', `${name} cannot be empty.`);
    return value;
  }

  const action = await question(`${name} is configured; keep, replace, or delete`, 'keep');
  if (action === 'keep') return undefined;
  if (action === 'delete') return null;
  if (action === 'replace') {
    const value = await hiddenQuestion(`New ${name}`);
    if (!value) throw new InitError('invalid_input', `${name} cannot be empty.`);
    return value;
  }
  throw new InitError('invalid_input', `Unknown action for ${name}.`);
}

/**
 * Shown before the token prompts, because the tokens only exist once the app
 * does. Reached only from the interactive path, so `--from-stdin` and non-TTY
 * runs never print onboarding text or touch a browser.
 */
async function offerSlackAppCreation(): Promise<void> {
  const report = slackManifestReport();
  console.log('');
  printSlackAppSetupSteps(report);
  const answer = await question('Open this link in your browser now? (yes/no)', 'no');
  if (!/^y(?:es)?$/i.test(answer)) return;
  const opened = await openInBrowser(report.createUrl);
  if (!opened) console.log('Could not open a browser. Use the link above.');
}

async function interactiveInput(current: ControlConfiguration): Promise<InitInput> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new InitError(
      'tty_required',
      'Interactive initialization requires a TTY. Use --from-stdin for automation.',
    );
  }
  const agentBackend = await question('Agent backend (pi or claude-agent-sdk)', current.settings.agentBackend);
  if (agentBackend !== 'pi' && agentBackend !== 'claude-agent-sdk') {
    throw new InitError('invalid_input', 'Agent backend must be pi or claude-agent-sdk.');
  }
  const model = await question('Model (provider/model)', current.settings.model ?? undefined);
  const effortAnswer = await question(
    'Effort (medium, high, xhigh, or none)',
    current.settings.effort ?? 'none',
  );
  const effort = effortAnswer === 'none' ? null : effortAnswer;
  if (effort !== null && !AGENT_EFFORT_LEVELS.includes(effort as never)) {
    throw new InitError('invalid_input', 'Effort must be medium, high, xhigh, or none.');
  }
  const workspace = await question('Workspace', current.settings.workspace);
  if (!current.secrets['slack.botToken'].configured || !current.secrets['slack.appToken'].configured) {
    await offerSlackAppCreation();
  }
  const secretChanges: Partial<Record<SecretName, string | null>> = {};
  for (const name of SECRET_NAMES) {
    const required =
      name === 'slack.botToken' ||
      name === 'slack.appToken' ||
      (name === 'claudeAgentSdk.oauthToken' && agentBackend === 'claude-agent-sdk');
    const change = await secretChoice(name, current.secrets[name].configured, required);
    if (change !== undefined) secretChanges[name] = change;
  }
  return {
    settings: {
      agentBackend,
      model,
      effort: effort as PublicSettings['effort'],
      workspace,
    },
    secretChanges,
  };
}

function automatedInput(raw: unknown, current: ControlConfiguration): InitInput {
  const result = stdinSchema.safeParse(raw);
  if (!result.success) {
    throw new InitError('invalid_input', 'The stdin initialization document is invalid.');
  }
  const value = result.data;
  const settings = {
    agentBackend: value.agentBackend ?? value.backend ?? current.settings.agentBackend,
    model: value.model ?? current.settings.model,
    effort: value.effort === undefined ? current.settings.effort : value.effort,
    workspace: value.workspace ?? current.settings.workspace,
  };
  if (!settings.model) {
    throw new InitError('invalid_input', 'model is required when configuration is incomplete.');
  }
  return {
    settings: settings as PublicSettings,
    secretChanges: value.secrets ?? {},
  };
}

function changedSettings(current: PublicSettings, desired: PublicSettings): SettingsPatch {
  const patch: SettingsPatch = {};
  if (current.agentBackend !== desired.agentBackend) patch.agentBackend = desired.agentBackend;
  if (current.model !== desired.model && desired.model !== null) patch.model = desired.model;
  if (current.effort !== desired.effort) patch.effort = desired.effort;
  if (current.workspace !== desired.workspace) patch.workspace = desired.workspace;
  return patch;
}

function validateInput(input: InitInput, current: ControlConfiguration): void {
  if (!input.settings.model || !/^[^/\s]+\/[^/\s]+$/.test(input.settings.model)) {
    throw new InitError('invalid_input', 'model must use the provider/model form.');
  }
  if (
    input.settings.agentBackend === 'claude-agent-sdk' &&
    !input.settings.model.startsWith('anthropic/')
  ) {
    throw new InitError(
      'invalid_input',
      'Claude Agent SDK models must use the anthropic/<model> form.',
    );
  }
  if (!path.isAbsolute(input.settings.workspace) || input.settings.workspace.includes('\0')) {
    throw new InitError('invalid_input', 'workspace must be an absolute path.');
  }
  for (const [name, value] of Object.entries(input.secretChanges) as Array<
    [SecretName, string | null]
  >) {
    if (value === null) continue;
    const requiredPrefix =
      name === 'slack.botToken' ? 'xoxb-' : name === 'slack.appToken' ? 'xapp-' : null;
    if (!value || value.includes('\0') || (requiredPrefix && !value.startsWith(requiredPrefix))) {
      throw new InitError('invalid_input', `The value for ${name} is invalid.`);
    }
  }
  const configuredAfterChanges = (name: SecretName): boolean => {
    const change = input.secretChanges[name];
    if (typeof change === 'string') return true;
    if (change === null) return current.secrets[name].source === 'environment';
    return current.secrets[name].configured;
  };
  const missing = SECRET_NAMES.filter((name) => {
    if (name === 'claudeAgentSdk.oauthToken' && input.settings.agentBackend !== 'claude-agent-sdk') {
      return false;
    }
    return !configuredAfterChanges(name);
  });
  if (missing.length > 0) {
    throw new InitError(
      'configuration_incomplete',
      `Required secrets are missing: ${missing.join(', ')}.`,
    );
  }
}

async function restartAfterInit(socketFile: string, supervision: string): Promise<RestartResult> {
  if (supervision === 'foreground') {
    try {
      await requestDaemonRestart(socketFile);
    } catch (error) {
      if (error instanceof ControlRequestError) {
        return { requested: true, outcome: 'manual_required', code: error.code };
      }
      throw error;
    }
    return { requested: true, outcome: 'manual_required', code: 'restart_not_observed' };
  }
  try {
    const status = await restartLaunchAgent();
    return {
      requested: true,
      outcome: 'restarted',
      startupState: status.control.status?.runtime.state ?? 'unreachable',
    };
  } catch (error) {
    if (error instanceof ServiceLifecycleError) {
      return { requested: true, outcome: 'manual_required', code: error.code };
    }
    throw error;
  }
}

async function runInit(options: {
  fromStdin: boolean;
  noRestart: boolean;
}): Promise<InitResult> {
  const home = createSkyHome();
  let current: ControlConfiguration;
  let status;
  try {
    status = await getDaemonStatus(home.socketFile);
  } catch (error) {
    throw new InitError(
      'daemon_unavailable',
      'The daemon control socket is unavailable. Run `sky service install` or `sky start`, then retry.',
      error,
    );
  }
  try {
    current = await getConfiguration(home.socketFile);
  } catch (error) {
    if (error instanceof ControlRequestError) {
      throw new InitError(error.code, `Configuration cannot be read: ${error.code}.`, error);
    }
    throw new InitError('daemon_unavailable', 'The daemon stopped responding.', error);
  }

  const input = options.fromStdin
    ? automatedInput(await readStdinDocument(), current)
    : await interactiveInput(current);
  validateInput(input, current);
  const patch = changedSettings(current.settings, input.settings);
  const changedNonSecretFields = Object.keys(patch) as Array<keyof PublicSettings>;
  if (changedNonSecretFields.length > 0 || current.revision === 0) {
    current = await patchConfiguration(home.socketFile, current.revision, {
      ...patch,
      ...(current.revision === 0
        ? {
            agentBackend: input.settings.agentBackend,
            model: input.settings.model!,
            effort: input.settings.effort,
            workspace: input.settings.workspace,
          }
        : {}),
    });
  }

  for (const name of SECRET_NAMES) {
    const change = input.secretChanges[name];
    if (change === undefined) continue;
    current =
      change === null
        ? await deleteSecret(home.socketFile, name)
        : await putSecret(home.socketFile, name, change);
  }

  current = await getConfiguration(home.socketFile);
  if (!current.complete) {
    throw new InitError(
      'configuration_incomplete',
      'Configuration was saved but remains incomplete. Rerun `sky init` to provide required secrets.',
    );
  }
  let workspace: WorkspaceBootstrapResult;
  try {
    workspace = bootstrapWorkspace(current.settings.workspace);
  } catch (error) {
    if (error instanceof WorkspaceBootstrapError) {
      throw new InitError(error.code, error.message, error);
    }
    throw error;
  }
  const restart = options.noRestart || !current.restartRequired
    ? ({ requested: false, outcome: 'not_requested' } as const)
    : await restartAfterInit(home.socketFile, status.supervision.mode);
  return {
    changedNonSecretFields,
    secrets: current.secrets,
    resultingRevision: current.revision,
    restartRequired: restart.outcome === 'restarted' ? false : current.restartRequired,
    restart,
    workspace,
  };
}

function reportResult(result: InitResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  console.log(`Configuration revision ${result.resultingRevision} saved.`);
  console.log(
    result.workspace.createdFiles.length > 0
      ? `Created workspace templates: ${result.workspace.createdFiles.join(', ')}`
      : 'Workspace templates are already present.',
  );
  if (result.restart.outcome === 'restarted') {
    console.log(`Sky restarted; startup state: ${result.restart.startupState}.`);
  } else if (result.restart.outcome === 'manual_required') {
    console.log(`Configuration is saved. Restart Sky manually (${result.restart.code}).`);
  } else {
    console.log(
      result.restartRequired
        ? 'Configuration is saved. Run `sky restart` to apply it.'
        : 'Configuration is already active.',
    );
  }
}

function reportError(error: unknown, json: boolean): void {
  const normalized =
    error instanceof InitError
      ? error
      : error instanceof ControlRequestError
        ? new InitError(error.code, `Initialization failed with ${error.code}.`, error)
        : new InitError('unexpected_error', 'Initialization failed unexpectedly.', error);
  if (json) {
    console.log(
      JSON.stringify({
        ok: false,
        error: { code: normalized.code, message: normalized.message },
      }, null, 2),
    );
  } else {
    console.error(`error: ${normalized.message}`);
  }
  process.exitCode = 1;
}

export const initCommand = new Command('init')
  .description('Configure Sky through the running daemon')
  .option('--from-stdin', 'Read one JSON initialization document from stdin')
  .option('--no-restart', 'Save configuration without restarting Sky')
  .option('--json', 'Print stable JSON output')
  .action(async (options: { fromStdin?: boolean; restart?: boolean; json?: boolean }) => {
    const json = options.json === true;
    try {
      reportResult(
        await runInit({
          fromStdin: options.fromStdin === true,
          noRestart: options.restart === false,
        }),
        json,
      );
    } catch (error) {
      reportError(error, json);
    }
  });
