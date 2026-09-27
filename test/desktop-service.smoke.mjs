import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const native = path.join(root, 'apps/desktop/src-tauri');
const bundle = path.join(native, 'target/aarch64-apple-darwin/release/bundle/macos/Sky.app');

test('SMAppService retains a host across app exits and preserves data through stop and unregister', { timeout: 240_000 }, async () => {
  assert.equal(process.platform, 'darwin');
  const temporary = await mkdtemp('/private/tmp/sky-service-');
  const applications = path.join(os.homedir(), 'Applications');
  await mkdir(applications, { recursive: true });
  const installation = await mkdtemp(path.join(applications, 'sky-service-test-'));
  const installed = path.join(installation, 'Applications With Spaces/Sky.app');
  const skyHome = path.join(temporary, 'sky-home');
  let registered = false;
  let safeToRemove = true;
  const run = (executable, args, options = {}) => execFileSync(executable, args, {
    encoding: 'utf8', timeout: 180_000, ...options,
  });
  const executable = path.join(installed, 'Contents/MacOS/sky-desktop');
  const act = (action, expectedError) => {
    const output = run(executable, ['--ignored', '--exact', 'service::tests::isolated_service_action', '--nocapture'], {
      env: { ...process.env, SKY_DESKTOP_SMOKE_HOME: skyHome, SKY_DESKTOP_SMOKE_ACTION: action, ...(expectedError ? { SKY_DESKTOP_SMOKE_EXPECT_ERROR: expectedError } : {}) },
    });
    const result = JSON.parse(output.match(/^SKY_SERVICE_RESULT=(.+)$/m)?.[1] ?? 'null');
    if (expectedError) {
      assert.equal(result?.Err?.code, expectedError, output);
      return result.Err;
    }
    assert.ok(result?.Ok, output);
    return result.Ok;
  };
  try {
    const artifacts = run('cargo', ['test', '--locked', '--no-run', '--message-format=json', '--manifest-path', path.join(native, 'Cargo.toml')])
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const testExecutable = artifacts.find((artifact) => artifact.reason === 'compiler-artifact' && artifact.profile.test && artifact.executable)?.executable;
    assert.ok(testExecutable);
    await cp(bundle, installed, { recursive: true });
    await cp(testExecutable, executable);
    const plistFile = path.join(installed, 'Contents/Library/LaunchAgents/com.jakdo.sky.skyd.plist');
    const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistFile]));
    assert.equal(plist.Label, 'com.ty91.skyd');
    assert.equal(plist.BundleProgram, 'Contents/MacOS/skyd');
    assert.deepEqual(plist.AssociatedBundleIdentifiers, ['com.jakdo.sky']);
    assert.equal(plist.ExitTimeOut, 30);
    assert.equal(plist.KeepAlive, true);
    assert.equal(plist.RunAtLoad, true);
    const bundleId = `com.jakdo.sky.test-${randomUUID().toLowerCase()}`;
    plist.Label = `${bundleId}.skyd`;
    plist.AssociatedBundleIdentifiers = [bundleId];
    run('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', bundleId, path.join(installed, 'Contents/Info.plist')]);
    plist.EnvironmentVariables.SKY_HOME = skyHome;
    plist.EnvironmentVariables.HOME = path.join(temporary, 'home');
    plist.EnvironmentVariables.PI_CODING_AGENT_DIR = path.join(temporary, 'pi');
    plist.ProgramArguments.push('--admin-port', '0');
    await writeFile(plistFile, JSON.stringify(plist));
    run('/usr/bin/plutil', ['-convert', 'xml1', plistFile]);
    if (process.env.SKY_DESKTOP_SIGNER) {
      run(process.env.SKY_DESKTOP_SIGNER, [installed]);
    } else {
      run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', installed]);
    }
    run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', installed]);
    await mkdir(skyHome);
    await mkdir(path.join(temporary, 'home'));
    const settings = `${JSON.stringify({ schemaVersion: 1, revision: 1, agentBackend: 'pi', model: 'anthropic/claude-sonnet-4-6', workspace: path.join(skyHome, 'workspace') })}\n`;
    await writeFile(path.join(skyHome, 'settings.json'), settings);
    const databaseFile = path.join(skyHome, 'sky.db');
    const database = new DatabaseSync(databaseFile);
    database.exec("CREATE TABLE preserved_data (value TEXT); INSERT INTO preserved_data VALUES ('keep me');");
    database.close();
    const assertPreserved = async () => {
      assert.equal(await readFile(path.join(skyHome, 'settings.json'), 'utf8'), settings);
      const db = new DatabaseSync(databaseFile, { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT value FROM preserved_data').get().value, 'keep me');
        assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'conversations'").get().name, 'conversations');
      } finally { db.close(); }
    };
    const initial = act('status');
    assert.ok(['notRegistered', 'notFound'].includes(initial.registration), JSON.stringify(initial));
    assert.equal(initial.hostState, 'notRegistered', JSON.stringify(initial));
    assert.equal(initial.canManage, true);
    assert.equal(act('unregister').hostState, 'notRegistered');
    registered = true;
    const started = act('register');
    assert.equal(started.registration, 'enabled', JSON.stringify(started));
    assert.equal(started.hostState, 'running', JSON.stringify(started));
    assert.equal(act('status').daemon.instanceId, started.daemon.instanceId);
    const restarted = act('restart');
    assert.equal(restarted.hostState, 'running');
    assert.notEqual(restarted.daemon.instanceId, started.daemon.instanceId);
    const stopped = act('stop');
    assert.equal(stopped.registration, 'enabled');
    assert.equal(stopped.hostState, 'stopped');
    assert.equal(act('status').hostState, 'stopped');
    await assertPreserved();
    const resumed = act('start');
    assert.equal(resumed.hostState, 'running');
    assert.notEqual(resumed.daemon.instanceId, restarted.daemon.instanceId);
    const removed = act('unregister');
    assert.equal(removed.registration, 'notRegistered');
    assert.equal(removed.daemon, null);
    registered = false;
    await assertPreserved();

    const validPlist = await readFile(plistFile, 'utf8');
    plist.ProgramArguments = ['skyd', '--eval', 'process.exit(78)'];
    plist.EnvironmentVariables.BUN_BE_BUN = '1';
    plist.KeepAlive = false;
    await writeFile(plistFile, JSON.stringify(plist));
    run('/usr/bin/plutil', ['-convert', 'xml1', plistFile]);
    const sign = () => process.env.SKY_DESKTOP_SIGNER
      ? run(process.env.SKY_DESKTOP_SIGNER, [installed])
      : run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', installed]);
    sign();
    registered = true;
    act('register', 'startup_failed');
    await writeFile(plistFile, validPlist);
    sign();
    const failed = act('status');
    assert.equal(failed.hostState, 'startupFailed');
    assert.equal(failed.canManage, false);
    assert.equal(failed.canRecover, true, JSON.stringify(failed));
    assert.match(failed.detail, /종료 코드/);
    const recovered = act('recover');
    assert.equal(recovered.hostState, 'running', JSON.stringify(recovered));
    assert.equal(recovered.canRecover, false);
    const reports = (await readdir(path.join(skyHome, 'logs'))).filter((name) => name.startsWith('service-recovery-'));
    assert.equal(reports.length, 1);
    const reportFile = path.join(skyHome, 'logs', reports[0]);
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(report.before.hostState, 'startupFailed');
    assert.equal(report.result.Ok.hostState, 'running');
    assert.equal((await stat(reportFile)).mode & 0o777, 0o600);
    await assertPreserved();
    act('recover', 'recovery_unavailable');
    assert.equal(act('status').daemon.instanceId, recovered.daemon.instanceId);
    assert.equal(act('unregister').registration, 'notRegistered');
    registered = false;
    await assertPreserved();
  } finally {
    if (registered) {
      try { act('unregister'); } catch (error) {
        safeToRemove = false;
        console.error(`Service cleanup failed. Preserved app at ${installed} and data at ${temporary}: ${error}`);
      }
    }
    if (safeToRemove) {
      run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', installed]);
      await rm(temporary, { recursive: true, force: true });
      await rm(installation, { recursive: true, force: true });
    }
  }
});
