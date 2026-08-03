import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ControlRequestError,
  deleteSecret,
  getConfiguration,
  getDaemonStatus,
  patchConfiguration,
  putSecret,
  requestDaemonRestart,
} from '../dist/skyd/control-uds.js';
import { startSkyd } from '../dist/skyd/app.js';
import { bootstrapWorkspace, WorkspaceBootstrapError } from '../dist/workspace-bootstrap.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const skyEntrypoint = path.join(repositoryRoot, 'dist', 'index.js');

async function runCli(args, homeDir, input) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: homeDir };
    delete env.SKY_HOME;
    const child = spawn(process.execPath, [skyEntrypoint, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.once('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

function permissions(stats) {
  return stats.mode & 0o777;
}

async function labeled(label, promise) {
  try {
    return await promise;
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

test('sky init configures an incomplete daemon through UDS and bootstraps idempotent prompts', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-init-cli-'));
  const workspace = path.join(homeDir, 'agent-workspace');
  const botToken = 'xoxb-init-never-print-1234';
  const appToken = 'xapp-init-never-print-5678';
  const daemon = await startSkyd({ homeDir });
  try {
    assert.equal(
      (await labeled('initial status', getDaemonStatus(daemon.paths.socketFile))).runtime.state,
      'needs_configuration',
    );
    const input = JSON.stringify({
      backend: 'pi',
      model: 'anthropic/test-model',
      effort: 'high',
      workspace,
      secrets: {
        'slack.botToken': botToken,
        'slack.appToken': appToken,
      },
    });
    const initialized = await runCli(
      ['init', '--from-stdin', '--no-restart', '--json'],
      homeDir,
      input,
    );
    assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);
    assert.doesNotMatch(initialized.stdout + initialized.stderr, new RegExp(`${botToken}|${appToken}`));
    const output = JSON.parse(initialized.stdout);
    assert.equal(output.ok, true);
    assert.deepEqual(output.changedNonSecretFields.toSorted(), [
      'effort',
      'model',
      'workspace',
    ]);
    assert.equal(output.resultingRevision, 1);
    assert.deepEqual(output.restart, { requested: false, outcome: 'not_requested' });
    assert.equal(output.restartRequired, true);
    assert.deepEqual(output.workspace.createdFiles.toSorted(), [
      'AGENTS.md',
      'MEMORY.md',
      'SOUL.md',
      'USER.md',
    ]);

    const snapshot = await labeled('configured snapshot', getConfiguration(daemon.paths.socketFile));
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.activeRevision, null);
    assert.equal(snapshot.restartRequired, true);
    assert.equal(snapshot.secrets['slack.botToken'].displayHint, 'xoxb-…1234');
    assert.equal(snapshot.secrets['slack.appToken'].displayHint, 'xapp-…5678');
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(`${botToken}|${appToken}`));
    assert.equal(
      (await labeled('configured status', getDaemonStatus(daemon.paths.socketFile))).runtime.state,
      'needs_configuration',
    );

    const settings = JSON.parse(await readFile(daemon.paths.settingsFile, 'utf8'));
    assert.deepEqual(settings, {
      schemaVersion: 1,
      revision: 1,
      agentBackend: 'pi',
      model: 'anthropic/test-model',
      effort: 'high',
      workspace,
    });
    assert.doesNotMatch(JSON.stringify(settings), /xoxb-|xapp-/);
    assert.equal(permissions(await lstat(daemon.paths.settingsFile)), 0o600);
    assert.equal(permissions(await lstat(daemon.paths.secretsFile)), 0o600);
    assert.equal(permissions(await lstat(workspace)), 0o700);
    for (const name of ['SOUL.md', 'AGENTS.md', 'USER.md', 'MEMORY.md']) {
      assert.equal(permissions(await lstat(path.join(workspace, name))), 0o600);
    }

    const userFile = path.join(workspace, 'USER.md');
    await writeFile(userFile, 'preserve me\n');
    await chmod(userFile, 0o640);
    const rerun = await runCli(
      ['init', '--from-stdin', '--no-restart', '--json'],
      homeDir,
      JSON.stringify({ model: 'anthropic/test-model', workspace }),
    );
    assert.equal(rerun.code, 0, rerun.stderr || rerun.stdout);
    assert.deepEqual(JSON.parse(rerun.stdout).changedNonSecretFields, []);
    assert.equal(await readFile(userFile, 'utf8'), 'preserve me\n');
    assert.equal(permissions(await lstat(userFile)), 0o640);

    const foregroundRestart = await runCli(
      ['init', '--from-stdin', '--json'],
      homeDir,
      JSON.stringify({ model: 'anthropic/test-model', workspace }),
    );
    assert.equal(foregroundRestart.code, 0, foregroundRestart.stderr || foregroundRestart.stdout);
    assert.deepEqual(JSON.parse(foregroundRestart.stdout).restart, {
      requested: true,
      outcome: 'manual_required',
      code: 'restart_unsupported_foreground',
    });
  } finally {
    await labeled('first daemon close', daemon.close());
  }

  let runtimeSettings;
  const replacement = await labeled(
    'replacement start',
    startSkyd({
      homeDir,
      startRuntime: async (settings) => {
        runtimeSettings = settings;
        return { close: async () => {} };
      },
    }),
  );
  try {
    let replacementStatus;
    try {
      replacementStatus = await getDaemonStatus(replacement.paths.socketFile);
    } catch (error) {
      error.message = `replacement status: ${error.message}`;
      throw error;
    }
    assert.equal(replacementStatus.runtime.state, 'ready');
    assert.equal(runtimeSettings.slack.botToken, botToken);
    assert.equal(runtimeSettings.slack.appToken, appToken);
    let applied;
    try {
      applied = await getConfiguration(replacement.paths.socketFile);
    } catch (error) {
      error.message = `replacement configuration: ${error.message}`;
      throw error;
    }
    assert.equal(applied.activeRevision, 1);
    assert.equal(applied.restartRequired, false);
  } finally {
    await labeled('replacement close', replacement.close());
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('configuration routes preserve disk state on invalid and conflicting updates and never return secrets', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-configuration-control-'));
  const daemon = await startSkyd({ homeDir });
  const botToken = 'xoxb-control-secret-1111';
  const replacementToken = 'xoxb-control-secret-2222';
  const appToken = 'xapp-control-secret-3333';
  try {
    const initial = await getConfiguration(daemon.paths.socketFile);
    assert.equal(initial.revision, 0);
    await assert.rejects(
      patchConfiguration(daemon.paths.socketFile, 0, { model: '' }),
      (error) => error instanceof ControlRequestError && error.code === 'invalid_value',
    );
    await assert.rejects(readFile(daemon.paths.settingsFile, 'utf8'), { code: 'ENOENT' });

    const configured = await patchConfiguration(daemon.paths.socketFile, 0, {
      agentBackend: 'pi',
      model: 'anthropic/control-model',
      workspace: daemon.paths.workspaceDir,
    });
    assert.equal(configured.revision, 1);
    const persisted = await readFile(daemon.paths.settingsFile, 'utf8');
    await assert.rejects(
      patchConfiguration(daemon.paths.socketFile, 0, { model: 'anthropic/lost-update' }),
      (error) =>
        error instanceof ControlRequestError &&
        error.code === 'revision_conflict' &&
        error.statusCode === 409,
    );
    assert.equal(await readFile(daemon.paths.settingsFile, 'utf8'), persisted);

    let snapshot = await putSecret(daemon.paths.socketFile, 'slack.botToken', botToken);
    snapshot = await putSecret(daemon.paths.socketFile, 'slack.appToken', appToken);
    snapshot = await putSecret(daemon.paths.socketFile, 'slack.botToken', replacementToken);
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.secrets['slack.botToken'].configured, true);
    assert.equal(snapshot.secrets['slack.botToken'].displayHint, 'xoxb-…2222');
    assert.doesNotMatch(
      JSON.stringify(snapshot),
      new RegExp(`${botToken}|${replacementToken}|${appToken}`),
    );
    snapshot = await deleteSecret(daemon.paths.socketFile, 'slack.botToken');
    assert.equal(snapshot.secrets['slack.botToken'].configured, false);
    assert.equal(snapshot.complete, false);
    await assert.rejects(
      putSecret(daemon.paths.socketFile, 'unknown.secret', 'never-print-this'),
      (error) => error instanceof ControlRequestError && error.code === 'unknown_secret',
    );
    const logs = await readFile(daemon.paths.logFile, 'utf8');
    assert.doesNotMatch(logs, new RegExp(`${botToken}|${replacementToken}|${appToken}|never-print-this`));
  } finally {
    await daemon.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('sky init refuses to write configuration when the daemon is unavailable', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-init-offline-'));
  try {
    const result = await runCli(
      ['init', '--from-stdin', '--no-restart', '--json'],
      homeDir,
      JSON.stringify({
        model: 'anthropic/offline',
        secrets: {
          'slack.botToken': 'xoxb-offline-secret',
          'slack.appToken': 'xapp-offline-secret',
        },
      }),
    );
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'daemon_unavailable');
    assert.doesNotMatch(result.stdout + result.stderr, /xoxb-offline-secret|xapp-offline-secret/);
    await assert.rejects(lstat(path.join(homeDir, '.sky')), { code: 'ENOENT' });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('configuration mutation is rejected with a stable error while the daemon drains', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-configuration-draining-'));
  const settingsFile = path.join(homeDir, '.sky', 'settings.json');
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(
    settingsFile,
    JSON.stringify({
      slack: { botToken: 'xoxb-draining-secret', appToken: 'xapp-draining-secret' },
      model: 'anthropic/draining-model',
    }),
    { mode: 0o600 },
  );
  let lease;
  const daemon = await startSkyd({
    homeDir,
    supervisionMode: 'launchd',
    startRuntime: async (_settings, controller) => {
      lease = controller.lease('slack_turn');
      return { close: async () => {} };
    },
  });
  try {
    const current = await getConfiguration(daemon.paths.socketFile);
    await requestDaemonRestart(daemon.paths.socketFile);
    assert.equal((await getDaemonStatus(daemon.paths.socketFile)).runtime.state, 'draining');
    await assert.rejects(
      patchConfiguration(daemon.paths.socketFile, current.revision, {
        model: 'anthropic/not-applied',
      }),
      (error) =>
        error instanceof ControlRequestError &&
        error.code === 'configuration_draining' &&
        error.statusCode === 409,
    );
  } finally {
    lease?.release();
    await daemon.finished;
    await rm(homeDir, { recursive: true, force: true });
  }
});

// Direct filesystem verification is intentional: symlink resolution and preservation are
// load-bearing bootstrap invariants whose failures are more diagnostic at this seam.
test('workspace bootstrap follows valid directory symlinks and rejects broken, cyclic, and file targets', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-workspace-bootstrap-'));
  try {
    const target = path.join(homeDir, 'target');
    const valid = path.join(homeDir, 'valid');
    await mkdir(target);
    await writeFile(path.join(target, 'SOUL.md'), 'existing soul\n');
    await chmod(path.join(target, 'SOUL.md'), 0o644);
    await symlink(target, valid);
    const result = bootstrapWorkspace(valid);
    assert.equal(result.workspace, await realpath(target));
    assert.ok(result.preservedFiles.includes('SOUL.md'));
    assert.equal(await readFile(path.join(target, 'SOUL.md'), 'utf8'), 'existing soul\n');
    assert.equal(permissions(await lstat(path.join(target, 'SOUL.md'))), 0o644);

    const broken = path.join(homeDir, 'broken');
    await symlink(path.join(homeDir, 'missing'), broken);
    assert.throws(
      () => bootstrapWorkspace(broken),
      (error) => error instanceof WorkspaceBootstrapError && error.code === 'workspace_invalid',
    );

    const cyclic = path.join(homeDir, 'cyclic');
    await symlink(cyclic, cyclic);
    assert.throws(
      () => bootstrapWorkspace(cyclic),
      (error) => error instanceof WorkspaceBootstrapError && error.code === 'workspace_invalid',
    );

    const file = path.join(homeDir, 'file');
    const fileLink = path.join(homeDir, 'file-link');
    await writeFile(file, 'not a directory');
    await symlink(file, fileLink);
    assert.throws(
      () => bootstrapWorkspace(fileLink),
      (error) => error instanceof WorkspaceBootstrapError && error.code === 'workspace_invalid',
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
