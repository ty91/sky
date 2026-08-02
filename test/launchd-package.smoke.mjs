import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const runsOnGitHubMacOS = process.platform === 'darwin' && process.env.GITHUB_ACTIONS === 'true';

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function runSky(sky, args, env) {
  const result = spawnSync(sky, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.signal, null, result.stderr);
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

test(
  'packed package runs through the real macOS LaunchAgent lifecycle',
  { skip: !runsOnGitHubMacOS, timeout: 240_000 },
  async () => {
    const tempRoot = await mkdtemp(
      path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'sky-launchd-package-'),
    );
    const packDir = path.join(tempRoot, 'pack');
    const homeDir = path.join(tempRoot, 'home');
    const pnpmHome = path.join(tempRoot, 'pnpm');
    const serviceTarget = `gui/${process.getuid()}/com.ty91.skyd`;
    const env = {
      ...process.env,
      HOME: homeDir,
      PNPM_HOME: pnpmHome,
      XDG_CACHE_HOME: path.join(tempRoot, 'cache'),
      XDG_CONFIG_HOME: path.join(tempRoot, 'config'),
      XDG_DATA_HOME: path.join(tempRoot, 'data'),
      PATH: [path.join(pnpmHome, 'bin'), pnpmHome, process.env.PATH ?? ''].join(path.delimiter),
    };

    try {
      await mkdir(packDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      const packResult = JSON.parse(
        run('pnpm', ['pack', '--pack-destination', packDir, '--json'], {
          cwd: repositoryRoot,
        }),
      );
      const tarball = path.isAbsolute(packResult.filename)
        ? packResult.filename
        : path.join(packDir, packResult.filename);
      run('pnpm', ['add', '--global', tarball], { env });
      const globalBin = run('pnpm', ['bin', '--global'], { env }).trim().split('\n').at(-1);
      assert.ok(globalBin);
      const sky = path.join(globalBin, 'sky');

      const installed = runSky(sky, ['service', 'install', '--json'], env);
      assert.equal(installed.code, 1, installed.stderr || installed.stdout);
      assert.equal(installed.json.status.launchd.loaded, true);
      assert.equal(installed.json.status.control.status.runtime.state, 'needs_configuration');

      const status = runSky(sky, ['status', '--json'], env);
      assert.equal(status.code, 1);
      assert.equal(status.json.status.control.status.runtime.state, 'needs_configuration');

      const stopped = runSky(sky, ['stop', '--json'], env);
      assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout);
      assert.equal(stopped.json.status.launchd.loaded, false);

      const started = runSky(sky, ['start', '--json'], env);
      assert.equal(started.code, 1, started.stderr || started.stdout);
      assert.equal(started.json.status.control.status.runtime.state, 'needs_configuration');

      const restarted = runSky(sky, ['restart', '--force', '--json'], env);
      assert.equal(restarted.code, 1, restarted.stderr || restarted.stdout);
      assert.equal(restarted.json.status.control.status.runtime.state, 'needs_configuration');

      const uninstalled = runSky(sky, ['service', 'uninstall', '--json'], env);
      assert.equal(uninstalled.code, 0, uninstalled.stderr || uninstalled.stdout);
      assert.equal(uninstalled.json.status.launchd.installed, false);
      assert.equal(uninstalled.json.status.launchd.loaded, false);
    } finally {
      spawnSync('launchctl', ['bootout', serviceTarget], { stdio: 'ignore' });
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
);
