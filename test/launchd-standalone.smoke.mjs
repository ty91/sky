import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const artifactSky = path.join(
  repositoryRoot,
  'dist',
  'standalone',
  'darwin-arm64',
  'sky',
);
const runtimePath = '/usr/bin:/bin';
const launchAgentLabel = 'com.ty91.skyd';
const serviceTarget = `gui/${process.getuid?.()}/${launchAgentLabel}`;
const supportedHost = process.platform === 'darwin' && process.arch === 'arm64';
const collisionMessage =
  'This manual-only smoke occupies the real com.ty91.skyd gui service target. Uninstall the existing Sky LaunchAgent before running it.';

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 90_000,
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function runSky(sky, args, env) {
  const result = run(sky, args, { env });
  return {
    code: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isServiceLoaded() {
  return run('/bin/launchctl', ['print', serviceTarget]).status === 0;
}

async function waitForServiceUnloaded(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isServiceLoaded()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${serviceTarget} remained loaded after lifecycle command completion.`);
}

async function waitForPathMissing(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await exists(filePath))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${filePath} remained present after the LaunchAgent stopped.`);
}

async function removeTemporaryRoot(tempRoot) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

async function parsePlist(plistFile) {
  const result = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistFile]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function xml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function legacyPlist({ homeDirectory, oldNodeDirectory, oldSkyd, skyHome }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchAgentLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(oldSkyd)}</string>
    <string>--foreground</string>
    <string>--supervised</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Standard</string>
  <key>Umask</key><integer>63</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xml(homeDirectory)}</string>
    <key>PATH</key><string>${xml(`${oldNodeDirectory}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
    <key>SKY_HOME</key><string>${xml(skyHome)}</string>
  </dict>
</dict>
</plist>
`;
}

async function installLegacyPlist(plistFile, content) {
  const launchAgentsDirectory = path.dirname(plistFile);
  await mkdir(launchAgentsDirectory, { recursive: true, mode: 0o700 });
  await writeFile(plistFile, content, { mode: 0o600 });
  await chmod(plistFile, 0o600);
  const linted = run('/usr/bin/plutil', ['-lint', plistFile]);
  assert.equal(linted.status, 0, linted.stderr);
  const bootstrapped = run('/bin/launchctl', [
    'bootstrap',
    `gui/${process.getuid()}`,
    plistFile,
  ]);
  assert.equal(bootstrapped.status, 0, bootstrapped.stderr);
}

async function waitForStandaloneDaemon(sky, env, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastResult;
  while (Date.now() < deadline) {
    lastResult = runSky(sky, ['status', '--json'], env);
    const daemon = lastResult.json?.status?.control?.status;
    if (daemon?.runtime?.kind === 'standalone') return daemon;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `standalone daemon did not become reachable: ${lastResult?.stderr ?? ''}\n${lastResult?.stdout ?? ''}`,
  );
}

test(
  'manual-only standalone artifact passes the real macOS LaunchAgent lifecycle without Node.js',
  { skip: !supportedHost, timeout: 240_000 },
  async () => {
    const userPlist = path.join(
      os.homedir(),
      'Library',
      'LaunchAgents',
      `${launchAgentLabel}.plist`,
    );
    assert.equal(isServiceLoaded(), false, collisionMessage);
    assert.equal(await exists(userPlist), false, collisionMessage);
    await access(artifactSky);

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'sky-launchd-standalone-'));
    const homeDirectory = path.join(tempRoot, 'home');
    const skyHome = path.join(tempRoot, 'sky-home');
    const stableBin = path.join(tempRoot, 'opt', 'bin');
    const legacyBin = path.join(tempRoot, 'legacy', 'bin');
    const temporaryDirectory = path.join(tempRoot, 'tmp');
    const stableSky = path.join(stableBin, 'sky');
    const stableSkyd = path.join(stableBin, 'skyd');
    const legacySkyd = path.join(legacyBin, 'skyd');
    const oldNodeDirectory = path.join(tempRoot, 'node@24', 'bin');
    const plistFile = path.join(
      homeDirectory,
      'Library',
      'LaunchAgents',
      `${launchAgentLabel}.plist`,
    );
    const env = {
      HOME: homeDirectory,
      SKY_HOME: skyHome,
      PATH: `${stableBin}:${runtimePath}`,
      TMPDIR: temporaryDirectory,
      XDG_CACHE_HOME: path.join(tempRoot, 'cache'),
      XDG_CONFIG_HOME: path.join(tempRoot, 'config'),
      XDG_DATA_HOME: path.join(tempRoot, 'data'),
      LANG: process.env.LANG ?? 'en_US.UTF-8',
    };

    try {
      await Promise.all([
        mkdir(homeDirectory, { recursive: true }),
        mkdir(stableBin, { recursive: true }),
        mkdir(legacyBin, { recursive: true }),
        mkdir(temporaryDirectory, { recursive: true }),
      ]);
      await Promise.all([
        symlink(artifactSky, stableSky),
        symlink(artifactSky, stableSkyd),
        symlink(artifactSky, legacySkyd),
      ]);
      for (const directory of env.PATH.split(path.delimiter)) {
        assert.equal(await exists(path.join(directory, 'node')), false);
        assert.equal(await exists(path.join(directory, 'bun')), false);
      }

      const installed = runSky(stableSky, ['service', 'install', '--json'], env);
      assert.equal(installed.code, 1, installed.stderr || installed.stdout);
      assert.equal(installed.json.changed, true);
      assert.equal(installed.json.status.launchd.loaded, true);
      assert.equal(installed.json.status.control.status.runtime.kind, 'standalone');
      assert.equal(installed.json.status.control.status.runtime.state, 'needs_configuration');

      const plist = await parsePlist(plistFile);
      assert.deepEqual(plist.ProgramArguments, [
        stableSkyd,
        '--foreground',
        '--supervised',
      ]);
      assert.doesNotMatch(plist.ProgramArguments[0], /dist\/standalone|darwin-arm64/);

      const status = runSky(stableSky, ['status', '--json'], env);
      assert.equal(status.code, 1, status.stderr || status.stdout);
      assert.equal(status.json.status.launchd.loaded, true);
      assert.equal(status.json.status.control.status.runtime.kind, 'standalone');

      const doctor = runSky(stableSky, ['doctor', '--json'], env);
      assert.equal(doctor.code, 1, doctor.stderr || doctor.stdout);
      const installationChecks = doctor.json.checks.filter(({ id }) =>
        id.startsWith('installation.'),
      );
      assert.equal(
        installationChecks.find(({ id }) => id === 'installation.runtime')?.status,
        'pass',
      );
      assert.equal(
        installationChecks.find(({ id }) => id === 'installation.executable')?.status,
        'pass',
      );
      assert.equal(installationChecks.some(({ id }) => id === 'installation.node'), false);
      assert.equal(
        installationChecks.some(({ status: checkStatus }) => checkStatus === 'fail'),
        false,
      );

      const stopped = runSky(stableSky, ['stop', '--json'], env);
      assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout);
      await waitForServiceUnloaded();

      const started = runSky(stableSky, ['start', '--json'], env);
      assert.equal(started.code, 1, started.stderr || started.stdout);
      assert.equal(started.json.status.control.status.runtime.kind, 'standalone');
      const startedInstanceId = started.json.status.control.status.instanceId;

      const restarted = runSky(stableSky, ['restart', '--force', '--json'], env);
      assert.equal(restarted.code, 1, restarted.stderr || restarted.stdout);
      assert.equal(restarted.json.status.control.status.runtime.kind, 'standalone');
      assert.notEqual(restarted.json.status.control.status.instanceId, startedInstanceId);

      const uninstalled = runSky(stableSky, ['service', 'uninstall', '--json'], env);
      assert.equal(uninstalled.code, 0, uninstalled.stderr || uninstalled.stdout);
      assert.equal(uninstalled.json.status.launchd.installed, false);
      await waitForServiceUnloaded();

      const oldPlist = legacyPlist({
        homeDirectory,
        oldNodeDirectory,
        oldSkyd: legacySkyd,
        skyHome,
      });
      await installLegacyPlist(plistFile, oldPlist);
      const legacyDaemon = await waitForStandaloneDaemon(stableSky, env);

      const reconciled = runSky(stableSky, ['service', 'install', '--json'], env);
      assert.equal(reconciled.code, 1, reconciled.stderr || reconciled.stdout);
      assert.equal(reconciled.json.changed, true);
      assert.notEqual(
        reconciled.json.status.control.status.instanceId,
        legacyDaemon.instanceId,
      );
      const reconciledPlist = await parsePlist(plistFile);
      assert.equal(reconciledPlist.ProgramArguments[0], stableSkyd);
      assert.equal(
        reconciledPlist.EnvironmentVariables.PATH.split(path.delimiter).includes(oldNodeDirectory),
        false,
      );

      const removedAfterReconcile = runSky(
        stableSky,
        ['service', 'uninstall', '--json'],
        env,
      );
      assert.equal(
        removedAfterReconcile.code,
        0,
        removedAfterReconcile.stderr || removedAfterReconcile.stdout,
      );
      await waitForServiceUnloaded();

      await installLegacyPlist(plistFile, oldPlist);
      await waitForStandaloneDaemon(stableSky, env);
      await unlink(stableSkyd);
      await symlink('/usr/bin/false', stableSkyd);

      const failed = runSky(stableSky, ['service', 'install', '--json'], env);
      assert.equal(failed.code, 1, failed.stderr || failed.stdout);
      assert.equal(failed.json.error.code, 'reconcile_failed');
      assert.deepEqual(failed.json.rollback, {
        attempted: true,
        succeeded: true,
        message: 'The previous LaunchAgent was restored.',
      });
      assert.equal(await readFile(plistFile, 'utf8'), oldPlist);
      await waitForStandaloneDaemon(stableSky, env);
    } finally {
      if (await exists(plistFile)) {
        run('/bin/launchctl', ['bootout', serviceTarget]);
        await waitForServiceUnloaded();
      }
      await waitForPathMissing(path.join(skyHome, 'run', 'skyd.sock'));
      await removeTemporaryRoot(tempRoot);
    }
  },
);
