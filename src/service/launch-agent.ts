import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
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
  ControlRequestError,
  getDaemonStatus,
  requestDaemonRestart,
} from '../skyd/control.js';
import type { DaemonStatus, RuntimeState } from '../skyd/types.js';

const execFileAsync = promisify(execFile);

export const LAUNCH_AGENT_LABEL = 'com.ty91.skyd';
const STARTUP_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 35_000;
const RESTART_TIMEOUT_MS = 155_000;
const LEGACY_STOP_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

type LaunchAgentPaths = {
  homeDir: string;
  logsDir: string;
  socketFile: string;
  legacyPidFile: string;
  legacyLogFile: string;
  migratedLegacyLogFile: string;
  launchAgentsDir: string;
  plistFile: string;
};

export type LaunchdStatus = {
  label: string;
  plistFile: string;
  installed: boolean;
  loaded: boolean;
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

export type LegacyMigrationState =
  | 'not_found'
  | 'stale_pid_removed'
  | 'unrelated_process_ignored'
  | 'terminated';

export type RollbackResult = {
  attempted: boolean;
  succeeded: boolean | null;
  message: string | null;
};

export type InstallResult = {
  changed: boolean;
  legacyMigration: LegacyMigrationState;
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

function launchAgentPaths(homeDir = os.homedir()): LaunchAgentPaths {
  const skyDir = path.join(homeDir, '.sky');
  const logsDir = path.join(skyDir, 'logs');
  return {
    homeDir,
    logsDir,
    socketFile: path.join(skyDir, 'run', 'skyd.sock'),
    legacyPidFile: path.join(skyDir, 'sky.pid'),
    legacyLogFile: path.join(skyDir, 'sky.log'),
    migratedLegacyLogFile: path.join(logsDir, 'legacy-sky.log'),
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

function resolveExecutable(name: string, searchPath = process.env.PATH): string {
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
  throw new ServiceLifecycleError(
    'skyd_wrapper_not_found',
    'Could not find the skyd package wrapper on PATH. Reinstall or relink @ty91/sky globally.',
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

function launchAgentPathValue(skydWrapper: string): string {
  const entries = [
    path.dirname(process.execPath),
    path.dirname(skydWrapper),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return [...new Set(entries)].join(':');
}

function desiredPlist(paths: LaunchAgentPaths, skydWrapper: string): string {
  const environmentPath = launchAgentPathValue(skydWrapper);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(skydWrapper)}</string>
    <string>--foreground</string>
    <string>--supervised</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(paths.homeDir)}</string>
    <key>PATH</key>
    <string>${xml(environmentPath)}</string>
  </dict>
</dict>
</plist>
`;
}

function ensureLaunchAgentsDirectory(paths: LaunchAgentPaths): void {
  mkdirSync(paths.launchAgentsDir, { recursive: true, mode: 0o700 });
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

async function launchdStatus(paths: LaunchAgentPaths): Promise<LaunchdStatus> {
  const output = await rawLaunchdPrint();
  const state = output?.match(/^\s*state\s*=\s*(.+?)\s*$/m)?.[1] ?? null;
  return {
    label: LAUNCH_AGENT_LABEL,
    plistFile: paths.plistFile,
    installed: existsSync(paths.plistFile),
    loaded: output !== null,
    state,
    pid: output === null ? null : parseNumber(output, 'pid'),
    lastExitStatus: output === null ? null : parseNumber(output, 'last exit code'),
  };
}

async function controlStatus(socketFile: string): Promise<ServiceStatus['control']> {
  try {
    return { reachable: true, status: await getDaemonStatus(socketFile) };
  } catch {
    return { reachable: false, status: null };
  }
}

export async function getServiceStatus(): Promise<ServiceStatus> {
  assertMacOS();
  const paths = launchAgentPaths();
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

function readLegacyPid(pidFile: string): number | null {
  try {
    const value = Number(readFileSync(pidFile, 'utf8').trim());
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processCommand(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function legacyBotEntry(command: string): string | null {
  const match = command.match(/(?:^|\s)(\/\S*\/dist\/bot\.js)(?:\s|$)/);
  if (!match) return null;
  const entry = match[1];
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(path.dirname(entry), '..', 'package.json'), 'utf8'),
    ) as { name?: unknown };
    return manifest.name === '@ty91/sky' ? entry : null;
  } catch {
    return null;
  }
}

async function isVerifiedLegacyProcess(pid: number): Promise<boolean> {
  if (!processExists(pid)) return false;
  const command = await processCommand(pid);
  return command !== null && legacyBotEntry(command) !== null;
}

function moveLegacyLogOnce(paths: LaunchAgentPaths): void {
  if (!existsSync(paths.legacyLogFile) || existsSync(paths.migratedLegacyLogFile)) return;
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.logsDir, 0o700);
  renameSync(paths.legacyLogFile, paths.migratedLegacyLogFile);
  chmodSync(paths.migratedLegacyLogFile, 0o600);
}

async function migrateLegacyDaemon(paths: LaunchAgentPaths): Promise<LegacyMigrationState> {
  if (!existsSync(paths.legacyPidFile)) {
    moveLegacyLogOnce(paths);
    return 'not_found';
  }

  const pid = readLegacyPid(paths.legacyPidFile);
  if (pid === null || !processExists(pid)) {
    rmSync(paths.legacyPidFile, { force: true });
    moveLegacyLogOnce(paths);
    return 'stale_pid_removed';
  }

  if (!(await isVerifiedLegacyProcess(pid))) {
    rmSync(paths.legacyPidFile, { force: true });
    moveLegacyLogOnce(paths);
    return 'unrelated_process_ignored';
  }

  // Re-read the command immediately before signaling to narrow the PID reuse window.
  if (!(await isVerifiedLegacyProcess(pid))) {
    rmSync(paths.legacyPidFile, { force: true });
    moveLegacyLogOnce(paths);
    return 'unrelated_process_ignored';
  }

  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + LEGACY_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      rmSync(paths.legacyPidFile, { force: true });
      moveLegacyLogOnce(paths);
      return 'terminated';
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new ServiceLifecycleError(
    'legacy_daemon_stop_timeout',
    'The verified legacy Sky daemon did not stop within 20 seconds. Installation was aborted without sending SIGKILL.',
  );
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
  const skydWrapper = resolveExecutable('skyd');
  const desired = desiredPlist(paths, skydWrapper);
  const previous = readExistingPlist(paths);
  const changed = previous !== desired;
  const legacyMigration = await migrateLegacyDaemon(paths);

  await assertNoUnmanagedDaemon(paths);

  if (!changed) {
    const current = await launchdStatus(paths);
    if (!current.loaded) await bootstrap(paths);
    const status = await waitForStartup(paths);
    return {
      changed: false,
      legacyMigration,
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
      legacyMigration,
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
