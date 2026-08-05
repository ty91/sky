import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  createSkyHome,
  ensurePrivateDirectory,
  prepareSkyHome,
  type SkyHome,
} from '../sky-home.js';
import {
  ControlRequestError,
  getDaemonStatus,
  requestDaemonRestart,
} from '../skyd/control-uds.js';
import type { DaemonStatus, RuntimeState } from '../skyd/types.js';

const execFileAsync = promisify(execFile);

export const LAUNCH_AGENT_LABEL = 'com.ty91.skyd';
const STARTUP_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 35_000;
const RESTART_TIMEOUT_MS = 155_000;
const POLL_INTERVAL_MS = 250;
const CLAUDE_DIAGNOSTICS_ENV = 'SKY_CLAUDE_DIAGNOSTICS';

type LaunchAgentPaths = {
  skyHome: SkyHome;
  homeDir: string;
  logsDir: string;
  socketFile: string;
  launchdStdoutFile: string;
  launchdStderrFile: string;
  launchAgentsDir: string;
  plistFile: string;
};

export type LaunchdStatus = {
  label: string;
  plistFile: string;
  installed: boolean;
  loaded: boolean;
  autostart: boolean;
  state: string | null;
  pid: number | null;
  lastExitStatus: number | null;
};

export type ServiceStatus = {
  launchd: LaunchdStatus;
  control: {
    reachable: boolean;
    status: DaemonStatus | null;
  };
};

export type RollbackResult = {
  attempted: boolean;
  succeeded: boolean | null;
  message: string | null;
};

export type InstallResult = {
  changed: boolean;
  rollback: RollbackResult;
  status: ServiceStatus;
};

export class ServiceLifecycleError extends Error {
  readonly code: string;
  readonly rollback: RollbackResult;
  readonly status: ServiceStatus | null;

  constructor(
    code: string,
    message: string,
    options: {
      cause?: unknown;
      rollback?: RollbackResult;
      status?: ServiceStatus | null;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ServiceLifecycleError';
    this.code = code;
    this.rollback = options.rollback ?? {
      attempted: false,
      succeeded: null,
      message: null,
    };
    this.status = options.status ?? null;
  }
}

function launchAgentPaths(
  skyHome: SkyHome = createSkyHome(),
  homeDir = os.homedir(),
): LaunchAgentPaths {
  return {
    skyHome,
    homeDir,
    logsDir: skyHome.logsDir,
    socketFile: skyHome.socketFile,
    launchdStdoutFile: skyHome.launchdStdoutFile,
    launchdStderrFile: skyHome.launchdStderrFile,
    launchAgentsDir: path.join(homeDir, 'Library', 'LaunchAgents'),
    plistFile: path.join(homeDir, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`),
  };
}

function assertMacOS(): void {
  if (process.platform !== 'darwin') {
    throw new ServiceLifecycleError(
      'unsupported_platform',
      'Sky LaunchAgent management is supported only on macOS.',
    );
  }
  if (!process.getuid) {
    throw new ServiceLifecycleError('missing_user_id', 'Unable to determine the current user ID.');
  }
}

function userDomain(): string {
  return `gui/${process.getuid!()}`;
}

function serviceTarget(): string {
  return `${userDomain()}/${LAUNCH_AGENT_LABEL}`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function commandErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if ('stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()) {
    return error.stderr.trim();
  }
  return error.message;
}

async function run(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw new ServiceLifecycleError(
      'external_command_failed',
      `${command} ${args.join(' ')} failed: ${commandErrorMessage(error)}`,
      { cause: error },
    );
  }
}

function findExecutable(name: string, searchPath = process.env.PATH): string | null {
  for (const directory of searchPath?.split(path.delimiter) ?? []) {
    if (!directory) continue;
    const candidate = path.resolve(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH. The wrapper path itself is preserved; it is not realpathed.
    }
  }
  return null;
}

function resolveExecutable(name: string, searchPath = process.env.PATH): string {
  const found = findExecutable(name, searchPath);
  if (found) return found;
  throw new ServiceLifecycleError(
    'skyd_wrapper_not_found',
    'Could not find the skyd executable on PATH. Reinstall Sky with `brew install ty91/tap/sky`.',
  );
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function launchAgentPathValue(skydExecutable: string): string {
  const entries = [
    path.dirname(skydExecutable),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return [...new Set(entries)].join(':');
}

function desiredPlist(paths: LaunchAgentPaths, skydExecutable: string): string {
  const environmentPath = launchAgentPathValue(skydExecutable);
  const skyHomeEnvironment =
    paths.skyHome.source === 'override'
      ? `    <key>SKY_HOME</key>
    <string>${xml(paths.skyHome.rootDir)}</string>
`
      : '';
  const claudeDiagnosticsEnvironment =
    process.env[CLAUDE_DIAGNOSTICS_ENV] === '1'
      ? `    <key>${CLAUDE_DIAGNOSTICS_ENV}</key>
    <string>1</string>
`
      : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(skydExecutable)}</string>
    <string>--foreground</string>
    <string>--supervised</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(paths.launchdStdoutFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.launchdStderrFile)}</string>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(paths.homeDir)}</string>
    <key>PATH</key>
    <string>${xml(environmentPath)}</string>
${skyHomeEnvironment}${claudeDiagnosticsEnvironment}   </dict>
</dict>
</plist>
`;
}

function ensureLaunchAgentsDirectory(paths: LaunchAgentPaths): void {
  mkdirSync(paths.launchAgentsDir, { recursive: true, mode: 0o700 });
  ensurePrivateDirectory(paths.logsDir);
}

function temporaryPlistPath(paths: LaunchAgentPaths): string {
  return path.join(
    paths.launchAgentsDir,
    `.${LAUNCH_AGENT_LABEL}.${process.pid}.${randomUUID()}.tmp`,
  );
}

async function writeValidatedPlist(paths: LaunchAgentPaths, content: string): Promise<string> {
  ensureLaunchAgentsDirectory(paths);
  const temporaryFile = temporaryPlistPath(paths);
  writeFileSync(temporaryFile, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await run('plutil', ['-lint', temporaryFile]);
    return temporaryFile;
  } catch (error) {
    rmSync(temporaryFile, { force: true });
    throw error;
  }
}

function readExistingPlist(paths: LaunchAgentPaths): string | null {
  try {
    return readFileSync(paths.plistFile, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function rawLaunchdPrint(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('launchctl', ['print', serviceTarget()], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

function parseNumber(output: string, field: string): number | null {
  const match = output.match(new RegExp(`^\\s*${field}\\s*=\\s*(-?\\d+)\\s*$`, 'm'));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function hasAutostart(plist: string | null): boolean {
  return (
    plist !== null &&
    /<key>KeepAlive<\/key>\s*<true\s*\/>/.test(plist)
  );
}

async function launchdStatus(paths: LaunchAgentPaths): Promise<LaunchdStatus> {
  const output = process.platform === 'darwin' ? await rawLaunchdPrint() : null;
  const plist = readExistingPlist(paths);
  const state = output?.match(/^\s*state\s*=\s*(.+?)\s*$/m)?.[1] ?? null;
  return {
    label: LAUNCH_AGENT_LABEL,
    plistFile: paths.plistFile,
    installed: plist !== null,
    loaded: output !== null,
    autostart: hasAutostart(plist),
    state,
    pid: output === null ? null : parseNumber(output, 'pid'),
    lastExitStatus: output === null ? null : parseNumber(output, 'last exit code'),
  };
}

export async function inspectLaunchAgent(
  options: { skyHome?: SkyHome; homeDir?: string } = {},
): Promise<LaunchdStatus> {
  return launchdStatus(launchAgentPaths(options.skyHome, options.homeDir));
}

async function controlStatus(socketFile: string): Promise<ServiceStatus['control']> {
  try {
    return { reachable: true, status: await getDaemonStatus(socketFile) };
  } catch {
    return { reachable: false, status: null };
  }
}

export async function getServiceStatus(
  options: { skyHome?: SkyHome; homeDir?: string } = {},
): Promise<ServiceStatus> {
  assertMacOS();
  const paths = launchAgentPaths(options.skyHome, options.homeDir);
  const [launchd, control] = await Promise.all([
    launchdStatus(paths),
    controlStatus(paths.socketFile),
  ]);
  return { launchd, control };
}

function isStartupState(state: RuntimeState | undefined): state is Extract<
  RuntimeState,
  'ready' | 'needs_configuration' | 'degraded'
> {
  return state === 'ready' || state === 'needs_configuration' || state === 'degraded';
}

async function waitForStartup(paths: LaunchAgentPaths): Promise<ServiceStatus> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastStatus: ServiceStatus | null = null;
  while (Date.now() < deadline) {
    const [launchd, control] = await Promise.all([
      launchdStatus(paths),
      controlStatus(paths.socketFile),
    ]);
    lastStatus = { launchd, control };
    if (isStartupState(control.status?.runtime.state)) return lastStatus;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new ServiceLifecycleError(
    'startup_timeout',
    `skyd did not reach a startup state within ${STARTUP_TIMEOUT_MS / 1000} seconds.`,
    { status: lastStatus },
  );
}

async function waitForReplacement(
  paths: LaunchAgentPaths,
  previousInstanceId: string | undefined,
): Promise<ServiceStatus> {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  let lastStatus: ServiceStatus | null = null;
  while (Date.now() < deadline) {
    const [launchd, control] = await Promise.all([
      launchdStatus(paths),
      controlStatus(paths.socketFile),
    ]);
    lastStatus = { launchd, control };
    const daemon = control.status;
    if (
      daemon &&
      daemon.instanceId !== previousInstanceId &&
      isStartupState(daemon.runtime.state)
    ) {
      return lastStatus;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new ServiceLifecycleError(
    'restart_timeout',
    `skyd was not replaced and started within ${RESTART_TIMEOUT_MS / 1000} seconds.`,
    { status: lastStatus },
  );
}

function socketExists(socketFile: string): boolean {
  try {
    return lstatSync(socketFile).isSocket();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function waitForSocketRemoval(paths: LaunchAgentPaths): Promise<void> {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!socketExists(paths.socketFile)) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new ServiceLifecycleError(
    'stop_timeout',
    `The skyd control socket did not disappear within ${STOP_TIMEOUT_MS / 1000} seconds.`,
  );
}

async function bootstrap(paths: LaunchAgentPaths): Promise<void> {
  await run('launchctl', ['bootstrap', userDomain(), paths.plistFile]);
}

async function bootout(paths: LaunchAgentPaths): Promise<void> {
  const status = await launchdStatus(paths);
  if (!status.loaded) return;
  await run('launchctl', ['bootout', serviceTarget()]);
  await waitForSocketRemoval(paths);
}

async function assertNoUnmanagedDaemon(paths: LaunchAgentPaths): Promise<void> {
  const [launchd, control] = await Promise.all([
    launchdStatus(paths),
    controlStatus(paths.socketFile),
  ]);
  if (!launchd.loaded && control.reachable) {
    throw new ServiceLifecycleError(
      'unmanaged_daemon_running',
      'A foreground or otherwise unmanaged skyd is already running. Stop it before managing the LaunchAgent.',
      { status: { launchd, control } },
    );
  }
}

async function restorePreviousPlist(
  paths: LaunchAgentPaths,
  previousPlist: string | null,
  desiredWasInstalled: boolean,
): Promise<RollbackResult> {
  if (previousPlist === null) {
    if (desiredWasInstalled) {
      try {
        await bootout(paths);
      } catch {
        // The failed new job may never have loaded.
      }
      rmSync(paths.plistFile, { force: true });
    }
    return { attempted: false, succeeded: null, message: 'No previous plist was available.' };
  }

  let temporaryFile: string | undefined;
  try {
    await bootout(paths);
    temporaryFile = await writeValidatedPlist(paths, previousPlist);
    renameSync(temporaryFile, paths.plistFile);
    temporaryFile = undefined;
    await bootstrap(paths);
    await waitForStartup(paths);
    return { attempted: true, succeeded: true, message: 'The previous LaunchAgent was restored.' };
  } catch (error) {
    return {
      attempted: true,
      succeeded: false,
      message: `Rollback failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (temporaryFile) rmSync(temporaryFile, { force: true });
  }
}

export async function installLaunchAgent(): Promise<InstallResult> {
  assertMacOS();
  const paths = launchAgentPaths();
  prepareSkyHome(paths.skyHome);
  const skydExecutable = resolveExecutable('skyd');
  const desired = desiredPlist(paths, skydExecutable);
  const previous = readExistingPlist(paths);
  const changed = previous !== desired;

  await assertNoUnmanagedDaemon(paths);

  if (!changed) {
    const current = await launchdStatus(paths);
    if (!current.loaded) await bootstrap(paths);
    const status = await waitForStartup(paths);
    return {
      changed: false,
      rollback: { attempted: false, succeeded: null, message: null },
      status,
    };
  }

  let temporaryFile: string;
  try {
    temporaryFile = await writeValidatedPlist(paths, desired);
  } catch (error) {
    throw new ServiceLifecycleError('plist_validation_failed', commandErrorMessage(error), {
      cause: error,
    });
  }

  let desiredWasInstalled = false;
  try {
    await bootout(paths);
    renameSync(temporaryFile, paths.plistFile);
    desiredWasInstalled = true;
    await bootstrap(paths);
    const status = await waitForStartup(paths);
    return {
      changed: true,
      rollback: { attempted: false, succeeded: null, message: null },
      status,
    };
  } catch (error) {
    rmSync(temporaryFile, { force: true });
    const rollback = await restorePreviousPlist(paths, previous, desiredWasInstalled);
    throw new ServiceLifecycleError(
      'reconcile_failed',
      `LaunchAgent reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
        rollback,
        status: error instanceof ServiceLifecycleError ? error.status : null,
      },
    );
  }
}

export async function uninstallLaunchAgent(): Promise<ServiceStatus> {
  assertMacOS();
  const paths = launchAgentPaths();
  await bootout(paths);
  rmSync(paths.plistFile, { force: true });
  return getServiceStatus();
}

export async function startLaunchAgent(): Promise<ServiceStatus> {
  assertMacOS();
  const paths = launchAgentPaths();
  if (!existsSync(paths.plistFile)) {
    throw new ServiceLifecycleError(
      'service_not_installed',
      'Sky is not installed as a LaunchAgent. Run `sky service install` first.',
    );
  }
  await assertNoUnmanagedDaemon(paths);
  const current = await launchdStatus(paths);
  if (!current.loaded) {
    await bootstrap(paths);
  } else if (current.state !== 'running') {
    await run('launchctl', ['kickstart', serviceTarget()]);
  }
  return waitForStartup(paths);
}

export async function stopLaunchAgent(): Promise<ServiceStatus> {
  assertMacOS();
  const paths = launchAgentPaths();
  const current = await launchdStatus(paths);
  if (!current.loaded) {
    const control = await controlStatus(paths.socketFile);
    if (control.reachable) {
      throw new ServiceLifecycleError(
        'service_not_loaded',
        'The LaunchAgent is not loaded, but a skyd control socket is active. Stop the unmanaged daemon directly.',
        { status: { launchd: current, control } },
      );
    }
    return { launchd: current, control };
  }
  await bootout(paths);
  return getServiceStatus();
}

export async function restartLaunchAgent(options: { force?: boolean } = {}): Promise<ServiceStatus> {
  assertMacOS();
  const paths = launchAgentPaths();
  const [launchd, control] = await Promise.all([
    launchdStatus(paths),
    controlStatus(paths.socketFile),
  ]);
  const current = { launchd, control };

  if (!launchd.loaded) {
    if (control.reachable) {
      throw new ServiceLifecycleError(
        'foreground_daemon',
        'The reachable skyd is not supervised by the LaunchAgent and cannot be restarted.',
        { status: current },
      );
    }
    throw new ServiceLifecycleError(
      'service_not_loaded',
      'The Sky LaunchAgent is stopped or unloaded. Run `sky start` instead.',
      { status: current },
    );
  }

  const previousInstanceId = control.status?.instanceId;
  if (options.force) {
    await run('launchctl', ['kickstart', '-k', serviceTarget()]);
    return waitForReplacement(paths, previousInstanceId);
  }

  if (!control.reachable) {
    throw new ServiceLifecycleError(
      'daemon_unresponsive',
      'The daemon control socket is unreachable. Retry or use `sky restart --force`.',
      { status: current },
    );
  }

  try {
    await requestDaemonRestart(paths.socketFile);
  } catch (error) {
    if (error instanceof ControlRequestError) {
      throw new ServiceLifecycleError(
        error.code,
        `The daemon refused restart: ${error.code}.`,
        { cause: error, status: current },
      );
    }
    throw new ServiceLifecycleError(
      'daemon_unresponsive',
      'The daemon stopped responding before it could accept restart. Retry or use `sky restart --force`.',
      { cause: error, status: current },
    );
  }

  return waitForReplacement(paths, previousInstanceId);
}
