import { accessSync, constants, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Settings } from './settings.js';
import {
  createConfiguration,
  type PublicConfiguration,
} from './configuration.js';
import { getServiceStatus, type ServiceStatus } from './service/launch-agent.js';
import type { SkyHome } from './sky-home.js';
import type { DaemonStatus } from './skyd/types.js';
import { inspectPiBackend } from './connections.js';
import { slackManifestRemediation } from './slack/manifest.js';

const { version: PRODUCT_VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const PROMPT_FILES = [
  ['soul', 'SOUL.md'],
  ['agents', 'AGENTS.md'],
  ['user', 'USER.md'],
  ['memory', 'MEMORY.md'],
] as const;

export type DiagnosticStatus = 'pass' | 'warn' | 'fail';

export type DiagnosticCheck = {
  id: string;
  status: DiagnosticStatus;
  summary: string;
  detail: string | null;
  remediation: string | null;
};

export type DiagnosticsReport = {
  schemaVersion: 1;
  mode: 'daemon' | 'local-fallback';
  overall: DiagnosticStatus;
  checks: DiagnosticCheck[];
};

export type RunDiagnosticsOptions = {
  daemonStatus?: DaemonStatus;
  activeSettings?: Settings;
  homeDir?: string;
};

type ConfigurationInspection = {
  settings?: Settings;
  public?: PublicConfiguration;
  errorCode?: string;
  check: DiagnosticCheck;
};

function check(
  id: string,
  status: DiagnosticStatus,
  summary: string,
  detail: string | null = null,
  remediation: string | null = null,
): DiagnosticCheck {
  return { id, status, summary, detail, remediation };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function overallStatus(checks: DiagnosticCheck[]): DiagnosticStatus {
  if (checks.some(({ status }) => status === 'fail')) return 'fail';
  if (checks.some(({ status }) => status === 'warn')) return 'warn';
  return 'pass';
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

function ownedByCurrentUser(uid: number): boolean {
  return process.getuid === undefined || uid === process.getuid();
}

function inspectManagedPath(
  id: string,
  label: string,
  filePath: string,
  expected: 'directory' | 'file' | 'socket',
  expectedMode: number,
  required: boolean,
): DiagnosticCheck {
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return required
        ? check(
            id,
            'fail',
            `${label} is missing.`,
            null,
            'Run `sky service install` to recreate required managed paths.',
          )
        : check(id, 'pass', `${label} is not present and is not currently required.`);
    }
    return check(
      id,
      'fail',
      `${label} cannot be inspected.`,
      'The filesystem denied or failed the metadata lookup.',
      'Review the parent directory permissions, then run `sky doctor` again.',
    );
  }

  const hasExpectedType =
    expected === 'directory'
      ? stats.isDirectory()
      : expected === 'file'
        ? stats.isFile()
        : stats.isSocket();
  if (stats.isSymbolicLink()) {
    return check(
      id,
      'fail',
      `${label} is an unsafe symlink.`,
      `Expected a managed ${expected}.`,
      'Inspect and replace the symlink; Sky will not follow or chmod managed symlinks.',
    );
  }
  if (!hasExpectedType) {
    return check(
      id,
      'fail',
      `${label} has the wrong entry type.`,
      `Expected a ${expected}.`,
      'Move the entry aside after reviewing it, then run `sky service install`.',
    );
  }
  if (!ownedByCurrentUser(stats.uid)) {
    return check(
      id,
      'fail',
      `${label} is owned by another user.`,
      null,
      'Verify the entry is trusted, then restore ownership to the current user.',
    );
  }
  if ((stats.mode & 0o777) !== expectedMode) {
    return check(
      id,
      'fail',
      `${label} has unsafe permissions.`,
      `Expected ${octal(expectedMode)}, found ${octal(stats.mode)}.`,
      `After reviewing the entry, set its mode to ${octal(expectedMode)}.`,
    );
  }
  return check(id, 'pass', `${label} is a private ${expected}.`);
}

function inspectTree(
  id: string,
  label: string,
  root: string,
  directoryMode: number,
  fileMode: number,
): DiagnosticCheck {
  try {
    const pending = [root];
    let entries = 0;
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const name of readdirSync(directory)) {
        const entry = path.join(directory, name);
        const stats = lstatSync(entry);
        entries += 1;
        if (stats.isSymbolicLink()) {
          return check(
            id,
            'fail',
            `${label} contains an unsafe symlink.`,
            'Managed transcript entries must be real directories or regular files.',
            'Review and remove or replace the symlink without following it.',
          );
        }
        if (!ownedByCurrentUser(stats.uid)) {
          return check(
            id,
            'fail',
            `${label} contains an entry owned by another user.`,
            null,
            'Verify the entry, then restore ownership to the current user.',
          );
        }
        if (stats.isDirectory()) {
          if ((stats.mode & 0o777) !== directoryMode) {
            return check(
              id,
              'fail',
              `${label} contains a directory with unsafe permissions.`,
              `Expected ${octal(directoryMode)}, found ${octal(stats.mode)}.`,
              `After review, set managed transcript directories to ${octal(directoryMode)}.`,
            );
          }
          pending.push(entry);
        } else if (stats.isFile()) {
          if ((stats.mode & 0o777) !== fileMode) {
            return check(
              id,
              'fail',
              `${label} contains a file with unsafe permissions.`,
              `Expected ${octal(fileMode)}, found ${octal(stats.mode)}.`,
              `After review, set managed transcript files to ${octal(fileMode)}.`,
            );
          }
        } else {
          return check(
            id,
            'fail',
            `${label} contains an unsupported entry type.`,
            null,
            'Move the entry out of the managed transcript tree after reviewing it.',
          );
        }
      }
    }
    return check(id, 'pass', `${label} contains ${entries} private entries.`);
  } catch (error) {
    return check(
      id,
      'fail',
      `${label} cannot be inspected.`,
      errorCode(error) === 'EACCES' ? 'Permission was denied.' : 'A filesystem lookup failed.',
      'Review the transcript tree permissions, then run `sky doctor` again.',
    );
  }
}

function inspectConfiguration(home: SkyHome): ConfigurationInspection {
  try {
    const configuration = createConfiguration(home, { readOnly: true });
    const inspection = configuration.inspect();
    if (inspection.public.revision === 0) {
      return {
        public: inspection.public,
        errorCode: 'settings_missing',
        check: check(
          'configuration.settings',
          'fail',
          'Settings are missing.',
          null,
          'Create settings through the supported Sky configuration flow.',
        ),
      };
    }
    return {
      public: inspection.public,
      ...(inspection.public.complete
        ? { settings: configuration.resolveRuntime().settings }
        : {}),
      check: check('configuration.settings', 'pass', 'Settings are valid.'),
    };
  } catch (error) {
    const code = errorCode(error);
    const unsafe = code === 'settings_unsafe' || code === 'secrets_unsafe';
    const missing = code === 'settings_missing';
    return {
      ...(code ? { errorCode: code } : {}),
      check: check(
        'configuration.settings',
        'fail',
        unsafe
          ? 'Settings are unsafe and were not read.'
          : missing
            ? 'Settings are missing.'
            : 'Settings are invalid.',
        unsafe
          ? 'Sky home, settings, and secret storage must be current-user-owned real entries.'
          : code === 'settings_invalid' || code === 'secrets_invalid'
            ? 'Raw parse and validation details are intentionally omitted.'
            : null,
        unsafe
          ? 'Review the unsafe entry before restoring regular private configuration files.'
          : missing
            ? 'Create settings through the supported Sky configuration flow.'
            : 'Repair configuration without copying credential values into logs or support messages.',
      ),
    };
  }
}

function schemaCheck(configuration: ConfigurationInspection): DiagnosticCheck {
  if (configuration.errorCode === 'settings_version_unsupported') {
    return check(
      'configuration.schema',
      'fail',
      'The settings schema version is unsupported by this Sky version.',
      null,
      'Upgrade Sky or restore a settings document supported by the installed version.',
    );
  }
  if (configuration.errorCode || !configuration.public) {
    return check(
      'configuration.schema',
      'fail',
      'The settings schema could not be identified.',
      null,
      'Repair the settings document first.',
    );
  }
  return check('configuration.schema', 'pass', 'Settings use a supported schema.');
}

async function credentialChecks(
  configuration: ConfigurationInspection,
  homeDir: string,
): Promise<DiagnosticCheck[]> {
  if (!configuration.public) {
    return [
      check(
        'configuration.slack_credentials',
        'fail',
        'Slack credential state is unavailable.',
        null,
        'Repair settings first.',
      ),
      check(
        'configuration.backend',
        'fail',
        'Agent backend configuration is unavailable.',
        null,
        'Repair settings first.',
      ),
    ];
  }
  const settings = configuration.public.settings;
  const slackConfigured =
    configuration.public.secrets['slack.botToken'].configured &&
    configuration.public.secrets['slack.appToken'].configured;
  const slack = check(
    'configuration.slack_credentials',
    slackConfigured ? 'pass' : 'fail',
    slackConfigured
      ? 'Slack bot and app credentials are configured.'
      : 'One or more Slack credentials are missing.',
    null,
    slackConfigured
      ? null
      : 'Create the Slack app with `sky slack manifest`, install it to the workspace, then run `sky init` to store the bot and app tokens.',
  );

  const model = settings.model ?? '';
  const slash = model.indexOf('/');
  const modelShapeValid = slash > 0 && slash < model.length - 1;
  if (settings.agentBackend === 'claude-agent-sdk') {
    const modelValid = modelShapeValid && model.startsWith('anthropic/');
    const source = configuration.public.secrets['claudeAgentSdk.oauthToken'].source;
    const valid = modelValid && source !== null;
    return [
      slack,
      check(
        'configuration.backend',
        valid ? 'pass' : 'fail',
        valid
          ? `Claude Agent SDK backend, model, and ${source} credential are configured.`
          : 'Claude Agent SDK backend configuration is incomplete or invalid.',
        modelValid ? null : 'Claude Agent SDK models must use the anthropic/<model> form.',
        valid ? null : 'Configure an Anthropic model and Claude OAuth credential.',
      ),
    ];
  }
  if (!modelShapeValid) {
    return [
      slack,
      check(
        'configuration.backend',
        'fail',
        'Pi model name is invalid.',
        null,
        'Use a provider/model model name.',
      ),
    ];
  }
  try {
    const inspection = await inspectPiBackend(settings, homeDir);
    const valid =
      inspection.modelFound &&
      inspection.credentialConfigured &&
      inspection.effortCompatible;
    return [
      slack,
      check(
        'configuration.backend',
        valid ? 'pass' : 'fail',
        valid
          ? `Pi backend, model, and ${inspection.credentialSource ?? 'local'} credential are configured.`
          : 'Pi backend configuration is incomplete or invalid.',
        !inspection.modelFound
          ? 'The model is not present in the local Pi model registry.'
          : !inspection.credentialConfigured
            ? 'No local credential is configured for the selected provider.'
            : !inspection.effortCompatible
              ? 'The selected model does not support the configured effort level.'
              : null,
        valid ? null : 'Configure a locally available model and provider credential.',
      ),
    ];
  } catch {
    return [
      slack,
      check(
        'configuration.backend',
        'fail',
        'The local Pi model configuration could not be inspected.',
        'Raw model and credential errors are intentionally omitted.',
        'Repair the local Pi model registry or credential store.',
      ),
    ];
  }
}

function workspaceFailure(
  id: string,
  label: string,
  error: unknown,
  expected: string,
): DiagnosticCheck {
  const code = errorCode(error);
  const kind =
    code === 'ELOOP'
      ? 'a symlink cycle'
      : code === 'ENOENT'
        ? 'a broken symlink or missing target'
        : code === 'EACCES'
          ? 'a permission error'
          : 'a filesystem error';
  return check(
    id,
    'fail',
    `${label} has ${kind}.`,
    `Expected ${expected}.`,
    'Repair the target or permissions, then run `sky doctor` again.',
  );
}

function inspectWorkspace(workspace: string | undefined, home: SkyHome): DiagnosticCheck[] {
  if (!workspace) {
    return [
      check(
        'workspace.path',
        'fail',
        'Workspace configuration is unavailable.',
        null,
        'Repair settings first.',
      ),
      ...PROMPT_FILES.map(([id, name]) =>
        check(
          `workspace.prompt.${id}`,
          'warn',
          `${name} was not checked.`,
          'Workspace configuration is unavailable.',
          'Repair settings, then run `sky doctor` again.',
        ),
      ),
    ];
  }
  if (!path.isAbsolute(workspace)) {
    return [
      check(
        'workspace.path',
        'fail',
        'The configured workspace path is not absolute.',
        null,
        'Set workspace to an absolute directory path.',
      ),
      ...PROMPT_FILES.map(([id, name]) =>
        check(
          `workspace.prompt.${id}`,
          'warn',
          `${name} was not checked.`,
          'The workspace path is invalid.',
          'Repair the workspace path first.',
        ),
      ),
    ];
  }

  let resolvedWorkspace: string;
  try {
    resolvedWorkspace = realpathSync(workspace);
    const stats = statSync(resolvedWorkspace);
    if (!stats.isDirectory()) {
      return [
        check(
          'workspace.path',
          'fail',
          'The configured workspace does not resolve to a directory.',
          null,
          'Point workspace at a readable and writable directory.',
        ),
        ...PROMPT_FILES.map(([id, name]) =>
          check(
            `workspace.prompt.${id}`,
            'warn',
            `${name} was not checked.`,
            'The workspace target is not a directory.',
            'Repair the workspace path first.',
          ),
        ),
      ];
    }
    accessSync(resolvedWorkspace, constants.R_OK | constants.W_OK);
  } catch (error) {
    return [
      workspaceFailure('workspace.path', 'The configured workspace', error, 'a readable and writable directory'),
      ...PROMPT_FILES.map(([id, name]) =>
        check(
          `workspace.prompt.${id}`,
          'warn',
          `${name} was not checked.`,
          'The workspace could not be resolved.',
          'Repair the workspace path first.',
        ),
      ),
    ];
  }

  const checks: DiagnosticCheck[] = [
    check('workspace.path', 'pass', 'The configured workspace is readable and writable.'),
  ];
  const relative = path.relative(home.rootDir, resolvedWorkspace);
  const insideHome = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  checks.push(
    insideHome
      ? check('workspace.portability', 'pass', 'The workspace is inside Sky home.')
      : check(
          'workspace.portability',
          'warn',
          'The workspace uses a computer-specific path outside Sky home.',
          'Confirm this path when migrating Sky to another computer.',
          'Update workspace during migration if the destination path differs.',
        ),
  );

  for (const [id, name] of PROMPT_FILES) {
    const promptPath = path.join(resolvedWorkspace, name);
    try {
      const entryStats = lstatSync(promptPath);
      const target = entryStats.isSymbolicLink() ? realpathSync(promptPath) : promptPath;
      const targetStats = statSync(target);
      if (!targetStats.isFile()) {
        checks.push(
          check(
            `workspace.prompt.${id}`,
            'fail',
            `${name} does not resolve to a regular file.`,
            null,
            `Replace ${name} with a regular file or a valid file symlink.`,
          ),
        );
        continue;
      }
      accessSync(target, constants.R_OK);
      const empty = readFileSync(target, 'utf8').trim().length === 0;
      checks.push(
        empty
          ? check(
              `workspace.prompt.${id}`,
              'warn',
              `${name} is empty.`,
              null,
              `Add the intended prompt content to ${name}.`,
            )
          : check(`workspace.prompt.${id}`, 'pass', `${name} resolves to a non-empty file.`),
      );
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        let isSymlink = false;
        try {
          isSymlink = lstatSync(promptPath).isSymbolicLink();
        } catch {
          // The prompt entry itself is absent.
        }
        checks.push(
          isSymlink
            ? workspaceFailure(
                `workspace.prompt.${id}`,
                name,
                error,
                'a symlink to a readable regular file',
              )
            : check(
                `workspace.prompt.${id}`,
                'warn',
                `${name} is missing.`,
                null,
                `Create ${name} if this prompt role is needed.`,
              ),
        );
      } else {
        checks.push(
          workspaceFailure(
            `workspace.prompt.${id}`,
            name,
            error,
            'a readable regular file',
          ),
        );
      }
    }
  }
  return checks;
}

function supportedNodeVersion(): boolean {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  return major === 24 && (minor > 16 || (minor === 16 && patch >= 0));
}

function executableOnPath(name: string): boolean {
  for (const directory of process.env.PATH?.split(path.delimiter) ?? []) {
    if (!directory) continue;
    try {
      accessSync(path.resolve(directory, name), constants.X_OK);
      return true;
    } catch {
      // Keep searching.
    }
  }
  return false;
}

function installationChecks(
  home: SkyHome,
  daemon: DaemonStatus | undefined,
  service: ServiceStatus | undefined,
): DiagnosticCheck[] {
  const nodeSupported = supportedNodeVersion();
  const wrapper = executableOnPath('skyd');
  const checks = [
    check(
      'installation.node',
      nodeSupported ? 'pass' : 'fail',
      nodeSupported
        ? `Node.js ${process.versions.node} is supported.`
        : `Node.js ${process.versions.node} is unsupported.`,
      'Sky requires Node.js >=24.16.0 <25.',
      nodeSupported ? null : 'Install the Node.js version pinned by this Sky release.',
    ),
    check('installation.product', 'pass', `Sky package version is ${PRODUCT_VERSION}.`),
    check(
      'installation.wrapper',
      wrapper ? 'pass' : 'warn',
      wrapper ? 'The skyd package wrapper is executable.' : 'The skyd package wrapper is not on PATH.',
      null,
      wrapper ? null : 'Reinstall or relink @ty91/sky globally.',
    ),
  ];

  if (!service) {
    checks.push(
      check(
        'installation.launch_agent',
        'warn',
        'LaunchAgent status is unavailable on this platform or user context.',
        null,
        'Run doctor from the target macOS user session.',
      ),
      check(
        'installation.sky_home',
        'warn',
        'LaunchAgent Sky home could not be compared.',
        null,
        'Run doctor from the target macOS user session.',
      ),
    );
    return checks;
  }

  const launchd = service.launchd;
  const intentionalForeground = daemon?.supervision.mode === 'foreground';
  const launchStatus = launchd.loaded && launchd.state === 'running';
  checks.push(
    check(
      'installation.launch_agent',
      launchStatus || intentionalForeground ? 'pass' : 'warn',
      launchStatus
        ? 'The LaunchAgent is installed, loaded, and running.'
        : intentionalForeground
          ? 'The daemon is intentionally running in foreground supervision.'
          : launchd.installed
            ? 'The LaunchAgent is installed but is not running.'
            : 'The LaunchAgent is not installed.',
      launchd.lastExitStatus === null ? null : `Last stable launchd exit status: ${launchd.lastExitStatus}.`,
      launchStatus || intentionalForeground ? null : 'Run `sky service install` or `sky start`.',
    ),
  );

  if (!launchd.installed) {
    checks.push(
      check(
        'installation.sky_home',
        intentionalForeground ? 'pass' : 'warn',
        intentionalForeground
          ? 'Foreground daemon and CLI use the same Sky home.'
          : 'LaunchAgent Sky home cannot be compared before installation.',
        null,
        intentionalForeground ? null : 'Run `sky service install` with the intended SKY_HOME.',
      ),
    );
    return checks;
  }

  try {
    const plist = readFileSync(launchd.plistFile, 'utf8');
    const match = plist.match(/<key>SKY_HOME<\/key>\s*<string>([^<]*)<\/string>/);
    const declared = match?.[1]
      ?.replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'");
    const sameRoot = home.source === 'default' ? declared === undefined || declared === home.rootDir : declared === home.rootDir;
    checks.push(
      check(
        'installation.sky_home',
        sameRoot ? 'pass' : 'fail',
        sameRoot
          ? 'CLI and LaunchAgent use the same Sky home.'
          : 'CLI and LaunchAgent use different Sky homes.',
        null,
        sameRoot ? null : 'Re-run `sky service install` with the intended SKY_HOME.',
      ),
    );
  } catch {
    checks.push(
      check(
        'installation.sky_home',
        'fail',
        'The installed LaunchAgent plist cannot be inspected.',
        null,
        'Repair or reinstall the LaunchAgent.',
      ),
    );
  }
  return checks;
}

function runtimeChecks(daemon: DaemonStatus | undefined): DiagnosticCheck[] {
  if (!daemon) {
    return [
      check(
        'runtime.control',
        'warn',
        'The daemon control interface is unavailable.',
        'Runtime-only checks were not available; local checks still ran.',
        'Start Sky with `sky start`, then run `sky doctor` again.',
      ),
      check(
        'runtime.state',
        'warn',
        'Daemon runtime state is not available.',
        null,
        'Start Sky, then run `sky doctor` again.',
      ),
      check(
        'runtime.slack',
        'warn',
        'Slack connection state is not available.',
        'No network probe was attempted.',
        'Start Sky to inspect the state already observed by the daemon.',
      ),
      check(
        'runtime.errors',
        'warn',
        'Recent daemon error codes are not available.',
        null,
        'Start Sky, then run `sky doctor` again.',
      ),
    ];
  }

  const runtimeStatus: DiagnosticStatus =
    daemon.runtime.state === 'ready'
      ? 'pass'
      : daemon.runtime.state === 'starting' || daemon.runtime.state === 'draining'
        ? 'warn'
        : 'fail';
  const slackStatus: DiagnosticStatus =
    daemon.slack.state === 'connected'
      ? 'pass'
      : daemon.slack.state === 'not_configured'
        ? 'fail'
        : 'warn';
  const versionsMatch = daemon.productVersion === PRODUCT_VERSION;
  return [
    check(
      'runtime.control',
      versionsMatch ? 'pass' : 'fail',
      versionsMatch
        ? `The daemon control interface is reachable (Sky ${daemon.productVersion}).`
        : 'CLI and daemon product versions differ.',
      null,
      versionsMatch ? null : 'Restart the installed daemon using the same Sky package as the CLI.',
    ),
    check(
      'runtime.state',
      runtimeStatus,
      `Daemon runtime state is ${daemon.runtime.state}.`,
      `Supervision mode is ${daemon.supervision.mode}.`,
      runtimeStatus === 'pass' ? null : 'Review failed checks and restart Sky after repairs.',
    ),
    check(
      'runtime.slack',
      slackStatus,
      `Daemon-observed Slack connection state is ${daemon.slack.state}.`,
      'No new Slack network request was made.',
      slackStatus === 'pass'
        ? null
        : `Review Slack credentials and recent stable error codes. Doctor does not probe scopes; if the app is missing a scope or event, ${slackManifestRemediation()}`,
    ),
    check(
      'runtime.errors',
      daemon.recentErrors.length === 0 ? 'pass' : 'warn',
      daemon.recentErrors.length === 0
        ? 'The daemon reports no recent stable error codes.'
        : `Recent stable error codes: ${[...new Set(daemon.recentErrors.map(({ code }) => code))].join(', ')}.`,
      null,
      daemon.recentErrors.length === 0 ? null : 'Use `sky logs` for redacted operational context.',
    ),
  ];
}

function revisionCheck(
  disk: Settings | undefined,
  active: Settings | undefined,
  daemon: DaemonStatus | undefined,
): DiagnosticCheck {
  if (!daemon) {
    return check(
      'configuration.revision',
      'warn',
      'Active runtime configuration is not available for comparison.',
      null,
      'Start Sky, then run `sky doctor` again.',
    );
  }
  if (!disk || !active) {
    return check(
      'configuration.revision',
      daemon.runtime.state === 'needs_configuration' ? 'fail' : 'warn',
      'Disk and active runtime configuration could not be compared.',
      null,
      'Repair configuration and restart Sky.',
    );
  }
  const matches = JSON.stringify(disk) === JSON.stringify(active);
  return check(
    'configuration.revision',
    matches ? 'pass' : 'warn',
    matches
      ? 'Disk and active runtime configuration match.'
      : 'Disk configuration differs from the active runtime configuration.',
    matches ? null : 'A restart is required to apply the disk configuration.',
    matches ? null : 'Run `sky restart` after validating the changed settings.',
  );
}

function migrationCheck(home: SkyHome): DiagnosticCheck {
  const exists = (file: string): boolean => {
    try {
      lstatSync(file);
      return true;
    } catch {
      return false;
    }
  };
  if (exists(home.legacyLogFile) && exists(home.migratedLegacyLogFile)) {
    return check(
      'configuration.migration',
      'fail',
      'Legacy log migration has a destination conflict.',
      'Both the legacy log and migrated destination exist.',
      'Review both files before moving or deleting either one, then run `sky service install`.',
    );
  }
  const artifacts = [home.legacyPidFile, home.legacyLogFile].filter((file) => {
    return exists(file);
  });
  return check(
    'configuration.migration',
    artifacts.length === 0 ? 'pass' : 'warn',
    artifacts.length === 0
      ? 'No pending legacy runtime artifacts were found.'
      : 'Legacy runtime artifacts still need review or migration.',
    null,
    artifacts.length === 0 ? null : 'Run `sky service install` to perform the supported legacy migration.',
  );
}

export async function runDiagnostics(
  home: SkyHome,
  options: RunDiagnosticsOptions = {},
): Promise<DiagnosticsReport> {
  const daemon = options.daemonStatus;
  let service: ServiceStatus | undefined;
  try {
    service = await getServiceStatus({
      skyHome: home,
      homeDir: options.homeDir ?? os.homedir(),
    });
  } catch {
    service = undefined;
  }

  const configuration = inspectConfiguration(home);
  const homeDir = options.homeDir ?? os.homedir();
  const credentials = await credentialChecks(configuration, homeDir);
  const rootExists = (() => {
    try {
      return lstatSync(home.rootDir).isDirectory();
    } catch {
      return false;
    }
  })();
  const checks: DiagnosticCheck[] = [
    ...installationChecks(home, daemon, service),
    ...runtimeChecks(daemon),
    inspectManagedPath('filesystem.root', 'Sky home', home.rootDir, 'directory', 0o700, true),
    inspectManagedPath('filesystem.run', 'run directory', home.runDir, 'directory', 0o700, true),
    inspectManagedPath('filesystem.logs', 'logs directory', home.logsDir, 'directory', 0o700, true),
    inspectManagedPath(
      'filesystem.transcripts',
      'transcripts directory',
      home.transcriptsDir,
      'directory',
      0o700,
      true,
    ),
    inspectManagedPath(
      'filesystem.workspace',
      'default workspace directory',
      home.workspaceDir,
      'directory',
      0o700,
      true,
    ),
    inspectManagedPath('filesystem.settings', 'settings file', home.settingsFile, 'file', 0o600, true),
    inspectManagedPath('filesystem.secrets', 'secret store', home.secretsFile, 'file', 0o600, false),
    inspectManagedPath('filesystem.database', 'SQLite database', home.databaseFile, 'file', 0o600, false),
    inspectManagedPath('filesystem.database_wal', 'SQLite WAL', home.databaseWalFile, 'file', 0o600, false),
    inspectManagedPath('filesystem.database_shm', 'SQLite SHM', home.databaseShmFile, 'file', 0o600, false),
    inspectManagedPath('filesystem.cursor', 'memory cursor', home.memoryCursorFile, 'file', 0o600, false),
    inspectManagedPath('filesystem.log', 'structured log', home.logFile, 'file', 0o600, rootExists),
    ...[1, 2, 3, 4, 5].map((index) =>
      inspectManagedPath(
        `filesystem.log_archive.${index}`,
        `structured log archive ${index}`,
        `${home.logFile}.${index}`,
        'file',
        0o600,
        false,
      ),
    ),
    inspectManagedPath(
      'filesystem.launchd_log',
      'LaunchAgent stderr log',
      home.launchdStderrFile,
      'file',
      0o600,
      rootExists,
    ),
    inspectManagedPath(
      'filesystem.launchd_stdout_log',
      'LaunchAgent stdout log',
      home.launchdStdoutFile,
      'file',
      0o600,
      rootExists,
    ),
    inspectManagedPath('filesystem.socket', 'control socket', home.socketFile, 'socket', 0o600, Boolean(daemon)),
    rootExists
      ? inspectTree('filesystem.transcript_tree', 'Transcript tree', home.transcriptsDir, 0o700, 0o600)
      : check(
          'filesystem.transcript_tree',
          'fail',
          'Transcript tree is missing.',
          null,
          'Run `sky service install` to initialize Sky home.',
        ),
    configuration.check,
    schemaCheck(configuration),
    ...credentials,
    revisionCheck(configuration.settings, options.activeSettings, daemon),
    migrationCheck(home),
    ...inspectWorkspace(configuration.public?.settings.workspace, home),
  ];

  return {
    schemaVersion: 1,
    mode: daemon ? 'daemon' : 'local-fallback',
    overall: overallStatus(checks),
    checks,
  };
}
