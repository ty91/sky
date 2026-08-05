// Exercises the published tap the way a user would: install, put the daemon
// under launchd, upgrade from the previous formula revision, and confirm that
// `sky restart` clears the version drift the upgrade leaves behind.
//
// This runs after a release has updated ty91/homebrew-tap, so it is gated behind
// SKY_HOMEBREW_SMOKE=1 and never runs as part of `pnpm test`.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const enabled =
  process.platform === 'darwin' &&
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.SKY_HOMEBREW_SMOKE === '1';
const expectedVersion = process.env.SKY_HOMEBREW_VERSION;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function runSky(sky, args, env) {
  const result = spawnSync(sky, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.signal, null, result.stderr);
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

function formulaRevisions(tapDir) {
  const revisions = run('git', ['-C', tapDir, 'log', '--format=%H', '-n', '2', '--', 'Formula/sky.rb'])
    .trim()
    .split('\n')
    .filter(Boolean);
  return { current: revisions[0], previous: revisions[1] };
}

function checkStatus(report, id) {
  return report.checks.find((check) => check.id === id)?.status;
}

test(
  'the tap installs, upgrades, and reports the daemon drift an upgrade leaves behind',
  { skip: !enabled, timeout: 1_200_000 },
  async () => {
    assert.ok(expectedVersion, 'SKY_HOMEBREW_VERSION must name the released version');

    const brewPrefix = run('brew', ['--prefix']).trim();
    const sky = path.join(brewPrefix, 'bin', 'sky');
    const tempRoot = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'sky-brew-'));
    const homeDir = path.join(tempRoot, 'home');
    const serviceTarget = `gui/${process.getuid()}/com.ty91.skyd`;
    // brew needs the real HOME for its own state; only Sky is redirected.
    const skyEnv = { ...process.env, HOME: homeDir };

    run('brew', ['tap', 'ty91/tap']);
    const tapDir = run('brew', ['--repo', 'ty91/tap']).trim();
    const { current, previous } = formulaRevisions(tapDir);
    const upgradeCovered = Boolean(previous) && previous !== current;

    try {
      await mkdir(homeDir, { recursive: true });

      if (upgradeCovered) {
        run('git', ['-C', tapDir, 'checkout', previous, '--', 'Formula/sky.rb']);
      } else {
        console.log('Only one formula revision exists; this run covers install but not upgrade.');
      }
      run('brew', ['install', 'ty91/tap/sky']);

      const installedVersion = run(sky, ['--version']).trim();
      if (!upgradeCovered) assert.equal(installedVersion, expectedVersion);

      // The daemon has no Slack credentials here, so it settles in
      // needs_configuration and the lifecycle commands report exit 1.
      const installed = runSky(sky, ['service', 'install', '--json'], skyEnv);
      assert.equal(installed.code, 1, installed.stderr || installed.stdout);
      assert.equal(installed.json.status.launchd.loaded, true);
      assert.equal(installed.json.status.control.status.runtime.state, 'needs_configuration');
      assert.equal(installed.json.status.control.status.productVersion, installedVersion);

      // The plist has to reference paths that survive an upgrade: the wrapper
      // symlink in the brew prefix, never a versioned Cellar directory.
      const plist = JSON.parse(
        run('plutil', ['-convert', 'json', '-o', '-', installed.json.status.launchd.plistFile]),
      );
      assert.equal(plist.ProgramArguments[0], path.join(brewPrefix, 'bin', 'skyd'));
      assert.ok(
        !plist.EnvironmentVariables.PATH.includes('/Cellar/'),
        `the plist PATH must not pin a Cellar directory: ${plist.EnvironmentVariables.PATH}`,
      );

      if (upgradeCovered) {
        run('git', ['-C', tapDir, 'checkout', current, '--', 'Formula/sky.rb']);
        run('brew', ['upgrade', 'sky']);

        const upgradedVersion = run(sky, ['--version']).trim();
        assert.equal(upgradedVersion, expectedVersion);
        assert.notEqual(upgradedVersion, installedVersion);

        // launchd may have restarted the daemon onto the new keg already; both
        // outcomes are correct, so record which one this run observed.
        const afterUpgrade = runSky(sky, ['doctor', '--json'], skyEnv);
        const drift = checkStatus(afterUpgrade.json, 'installation.drift');
        if (drift === 'fail') {
          const check = afterUpgrade.json.checks.find(({ id }) => id === 'installation.drift');
          assert.match(check.summary, new RegExp(installedVersion.replaceAll('.', '\\.')));
          assert.match(check.remediation, /sky restart/);
        } else {
          console.log(`launchd already replaced the daemon; drift check reported ${drift}.`);
        }

        const restarted = runSky(sky, ['restart', '--force', '--json'], skyEnv);
        assert.equal(restarted.code, 1, restarted.stderr || restarted.stdout);
        assert.equal(restarted.json.status.control.status.runtime.state, 'needs_configuration');
        assert.equal(restarted.json.status.control.status.productVersion, expectedVersion);
      }

      // Whatever path ran, the installed CLI and the running daemon must agree.
      const settled = runSky(sky, ['doctor', '--json'], skyEnv);
      assert.equal(checkStatus(settled.json, 'installation.drift'), 'pass');
      assert.equal(checkStatus(settled.json, 'installation.executable'), 'pass');
      assert.equal(checkStatus(settled.json, 'installation.runtime'), 'pass');

      const uninstalled = runSky(sky, ['service', 'uninstall', '--json'], skyEnv);
      assert.equal(uninstalled.code, 0, uninstalled.stderr || uninstalled.stdout);
      assert.equal(uninstalled.json.status.launchd.installed, false);
    } finally {
      spawnSync('launchctl', ['bootout', serviceTarget], { stdio: 'ignore' });
      spawnSync('git', ['-C', tapDir, 'checkout', current, '--', 'Formula/sky.rb'], {
        stdio: 'ignore',
      });
      spawnSync('brew', ['uninstall', 'sky'], { stdio: 'ignore' });
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
);
