import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const runtimePath = '/usr/bin:/bin:/usr/sbin:/sbin';
const launchAgentLabel = 'com.ty91.skyd';
const serviceTarget = `gui/${process.getuid?.()}/${launchAgentLabel}`;
const enabled =
  process.platform === 'darwin' &&
  process.arch === 'arm64' &&
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.SKY_RELEASE_SMOKE === '1';

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15 * 60_000,
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
    stdout: result.stdout,
    stderr: result.stderr,
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

function serviceLoaded() {
  return run('/bin/launchctl', ['print', serviceTarget]).status === 0;
}

function install(installer, version, env, artifactDirectory) {
  const args = ['-s', '--', '--version', version];
  if (artifactDirectory) {
    args.push('--artifact-base-url', pathToFileURL(artifactDirectory).href);
  }
  return run('/bin/sh', args, {
    env,
    input: installer,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function assertVersion(sky, version, env) {
  const result = run(sky, ['--version'], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), version);
}

function assertNeedsConfiguration(result, version) {
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.equal(result.json.status.launchd.loaded, true);
  assert.equal(result.json.status.control.status.runtime.kind, 'standalone');
  assert.equal(result.json.status.control.status.runtime.state, 'needs_configuration');
  assert.equal(result.json.status.control.status.productVersion, version);
}

function assertDoctorInstallationPasses(sky, env) {
  const doctor = runSky(sky, ['doctor', '--json'], env);
  assert.equal(doctor.code, 1, doctor.stderr || doctor.stdout);
  const installationChecks = doctor.json.checks.filter(({ id }) => id.startsWith('installation.'));
  assert.equal(installationChecks.some(({ status }) => status === 'fail'), false);
  for (const id of ['installation.runtime', 'installation.executable', 'installation.drift']) {
    assert.equal(installationChecks.find((check) => check.id === id)?.status, 'pass');
  }
}

function uninstallService(sky, env) {
  const result = runSky(sky, ['service', 'uninstall', '--json'], env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.json.status.launchd.installed, false);
  assert.equal(serviceLoaded(), false);
}

test(
  'published release installs and updates through the standalone user path',
  { skip: !enabled, timeout: 30 * 60_000 },
  async () => {
    const releaseVersion = process.env.SKY_RELEASE_VERSION;
    const smokeVersion = process.env.SKY_RELEASE_SMOKE_VERSION;
    const artifactDirectory = process.env.SKY_RELEASE_SMOKE_ARTIFACT_DIR;
    assert.ok(releaseVersion, 'SKY_RELEASE_VERSION must name the published release');
    assert.ok(smokeVersion, 'SKY_RELEASE_SMOKE_VERSION must name the lower test release');
    assert.ok(artifactDirectory, 'SKY_RELEASE_SMOKE_ARTIFACT_DIR must contain the lower release');
    assert.notEqual(releaseVersion, smokeVersion);
    assert.equal(serviceLoaded(), false, `${serviceTarget} is already loaded`);

    const root = await mkdtemp(
      path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'sky-release-smoke-'),
    );
    const homeDirectory = path.join(root, 'home');
    const skyHome = path.join(root, 'sky-home');
    const installDirectory = path.join(homeDirectory, '.local', 'bin');
    const temporaryDirectory = path.join(root, 'tmp');
    const sky = path.join(installDirectory, 'sky');
    const skyd = path.join(installDirectory, 'skyd');
    const env = {
      HOME: homeDirectory,
      SKY_HOME: skyHome,
      PATH: `${installDirectory}:${runtimePath}`,
      TMPDIR: temporaryDirectory,
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_DATA_HOME: path.join(root, 'data'),
      LANG: process.env.LANG ?? 'en_US.UTF-8',
    };

    try {
      await Promise.all([
        mkdir(homeDirectory, { recursive: true }),
        mkdir(temporaryDirectory, { recursive: true }),
      ]);
      for (const directory of env.PATH.split(path.delimiter)) {
        assert.equal(await exists(path.join(directory, 'node')), false);
        assert.equal(await exists(path.join(directory, 'bun')), false);
      }

      const installerResult = run(
        '/usr/bin/curl',
        [
          '-fsSL',
          '--retry',
          '3',
          `https://raw.githubusercontent.com/ty91/sky/v${releaseVersion}/install.sh`,
        ],
        { env },
      );
      assert.equal(installerResult.status, 0, installerResult.stderr);
      const installer = installerResult.stdout;

      const publishedInstall = install(installer, releaseVersion, env);
      assert.equal(publishedInstall.status, 0, publishedInstall.stderr);
      assertVersion(sky, releaseVersion, env);
      assert.equal((await lstat(sky)).isFile(), true);
      assert.equal(await readlink(skyd), 'sky');

      const installed = runSky(sky, ['service', 'install', '--json'], env);
      assertNeedsConfiguration(installed, releaseVersion);
      const installedInstanceId = installed.json.status.control.status.instanceId;
      assertDoctorInstallationPasses(sky, env);

      const stopped = runSky(sky, ['stop', '--json'], env);
      assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout);
      assert.equal(serviceLoaded(), false);

      const started = runSky(sky, ['start', '--json'], env);
      assertNeedsConfiguration(started, releaseVersion);
      const startedInstanceId = started.json.status.control.status.instanceId;
      assert.notEqual(startedInstanceId, installedInstanceId);

      const restarted = runSky(sky, ['restart', '--force', '--json'], env);
      assertNeedsConfiguration(restarted, releaseVersion);
      assert.notEqual(restarted.json.status.control.status.instanceId, startedInstanceId);
      uninstallService(sky, env);

      const lowerInstall = install(installer, smokeVersion, env, artifactDirectory);
      assert.equal(lowerInstall.status, 0, lowerInstall.stderr);
      assertVersion(sky, smokeVersion, env);

      const lowerService = runSky(sky, ['service', 'install', '--json'], env);
      assertNeedsConfiguration(lowerService, smokeVersion);
      const lowerInstanceId = lowerService.json.status.control.status.instanceId;

      const updateArgs = ['update'];
      if (releaseVersion.includes('-')) {
        updateArgs.push(
          '--release-api-url',
          `https://api.github.com/repos/ty91/sky/releases/tags/v${releaseVersion}`,
        );
      }
      const updated = run(sky, updateArgs, { env });
      assert.equal(updated.status, 0, updated.stderr || updated.stdout);
      assert.equal(
        updated.stdout.trim(),
        `Updated Sky from ${smokeVersion} to ${releaseVersion}.`,
      );
      assertVersion(sky, releaseVersion, env);

      const settled = runSky(sky, ['status', '--json'], env);
      assertNeedsConfiguration(settled, releaseVersion);
      assert.notEqual(settled.json.status.control.status.instanceId, lowerInstanceId);
      assertDoctorInstallationPasses(sky, env);
      uninstallService(sky, env);
    } finally {
      if (serviceLoaded()) run('/bin/launchctl', ['bootout', serviceTarget]);
      await rm(root, { recursive: true, force: true });
    }
  },
);
