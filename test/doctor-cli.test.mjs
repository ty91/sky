import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { startSkyd } from './helpers/start-skyd.mjs';
import { getDaemonStatus } from '../dist/skyd/control-uds.js';
import { SlackStartupError } from '../dist/bot.js';
import { PRODUCT_VERSION, runDiagnostics, withDaemonVersionDrift } from '../dist/diagnostics.js';
import { openConversationStore } from '../dist/conversation/store.js';
import { createSkyHome, prepareSkyHome } from '../dist/sky-home.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const skyEntrypoint = path.join(repositoryRoot, 'dist', 'index.js');

async function runCli(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [skyEntrypoint, ...args], {
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function waitForRuntime(socketFile, state) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = await getDaemonStatus(socketFile);
    if (status.runtime.state === state) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Runtime did not reach ${state}.`);
}

test('doctor uses a read-only local fallback when Sky has not been initialized', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-empty-'));
  const skyHome = path.join(homeDir, '.sky');
  try {
    const result = await runCli(['doctor', '--json'], {
      ...process.env,
      HOME: homeDir,
      SKY_HOME: skyHome,
    });

    assert.equal(result.code, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.mode, 'local-fallback');
    assert.equal(report.overall, 'fail');
    assert.ok(report.checks.length > 0);
    assert.deepEqual(Object.keys(report.checks[0]).toSorted(), [
      'detail',
      'id',
      'remediation',
      'status',
      'summary',
    ]);
    assert.equal(report.checks.some((check) => check.id === 'runtime.control'), true);
    assert.equal(report.checks.some((check) => check.id === 'filesystem.root'), true);
    assert.equal(
      report.checks.find((check) => check.id === 'configuration.settings')?.status,
      'fail',
    );
    await assert.rejects(stat(skyHome), { code: 'ENOENT' });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('doctor gets the assembled report from a live daemon over its real UDS', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-daemon-'));
  const skyHome = path.join(homeDir, '.sky');
  const workspace = path.join(skyHome, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(skyHome, 'settings.json'),
    JSON.stringify({
      slack: { botToken: 'xoxb-doctor-fixture', appToken: 'xapp-doctor-fixture' },
      model: 'anthropic/test-model',
      agentBackend: 'claude-agent-sdk',
      claudeAgentSdk: { oauthToken: 'oauth-doctor-fixture' },
      workspace,
    }),
  );
  for (const name of ['SOUL.md', 'AGENTS.md', 'USER.md', 'MEMORY.md']) {
    await writeFile(path.join(workspace, name), `${name} fixture\n`);
  }

  const daemon = await startSkyd({
    homeDir,
    startRuntime: async () => ({ close: async () => {} }),
  });
  try {
    const result = await runCli(['doctor', '--json'], {
      ...process.env,
      HOME: homeDir,
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'daemon');
    assert.equal(report.checks.find((check) => check.id === 'runtime.control')?.status, 'pass');
    assert.equal(report.checks.find((check) => check.id === 'runtime.state')?.status, 'pass');
    assert.equal(report.checks.find((check) => check.id === 'installation.drift')?.status, 'pass');
  } finally {
    await daemon.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

// `brew upgrade sky` replaces the files without touching the running daemon. The
// daemon assembles the report, so it can only ever compare its own version
// against itself; the CLI has to contribute this one.
test('doctor reports the stale daemon an upgrade leaves behind', () => {
  const report = {
    schemaVersion: 1,
    mode: 'daemon',
    overall: 'pass',
    checks: [
      { id: 'installation.node', status: 'pass', summary: '', detail: null, remediation: null },
      { id: 'runtime.control', status: 'pass', summary: '', detail: null, remediation: null },
    ],
  };

  const drifted = withDaemonVersionDrift(report, '0.0.1-stale');
  const check = drifted.checks.find(({ id }) => id === 'installation.drift');
  assert.equal(check.status, 'fail');
  assert.match(check.summary, /0\.0\.1-stale/);
  assert.match(check.summary, new RegExp(PRODUCT_VERSION.replaceAll('.', '\\.')));
  assert.match(check.remediation, /sky restart/);
  assert.equal(drifted.overall, 'fail');
  assert.deepEqual(
    drifted.checks.map(({ id }) => id),
    ['installation.node', 'installation.drift', 'runtime.control'],
  );
  assert.equal(report.checks.length, 2, 'the report the daemon sent must not be mutated');

  const aligned = withDaemonVersionDrift(report, PRODUCT_VERSION);
  assert.equal(aligned.checks.find(({ id }) => id === 'installation.drift').status, 'pass');
  assert.equal(aligned.overall, 'pass');
});

test('local fallback validates a healthy private filesystem, settings, and workspace', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-local-'));
  const skyHome = path.join(homeDir, '.sky');
  const workspace = path.join(skyHome, 'workspace');
  const binDir = path.join(homeDir, 'bin');
  try {
    for (const directory of [
      skyHome,
      path.join(skyHome, 'run'),
      path.join(skyHome, 'logs'),
      path.join(skyHome, 'transcripts'),
      workspace,
      binDir,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    await symlink(process.execPath, path.join(binDir, 'skyd'));
    await writeFile(
      path.join(skyHome, 'settings.json'),
      JSON.stringify({
        slack: { botToken: 'xoxb-local-fixture', appToken: 'xapp-local-fixture' },
        model: 'anthropic/test-model',
        agentBackend: 'claude-agent-sdk',
        claudeAgentSdk: { oauthToken: 'oauth-local-fixture' },
        workspace,
      }),
      { mode: 0o600 },
    );
    for (const name of ['SOUL.md', 'AGENTS.md', 'USER.md', 'MEMORY.md']) {
      await writeFile(path.join(workspace, name), `${name} fixture\n`, { mode: 0o600 });
    }
    for (const file of [
      path.join(skyHome, 'logs', 'skyd.jsonl'),
      path.join(skyHome, 'logs', 'launchd.stdout.log'),
      path.join(skyHome, 'logs', 'launchd.stderr.log'),
    ]) {
      await writeFile(file, '', { mode: 0o600 });
    }

    const result = await runCli(['doctor', '--json'], {
      ...process.env,
      HOME: homeDir,
      PATH: [binDir, process.env.PATH ?? ''].join(path.delimiter),
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'local-fallback');
    assert.equal(report.overall, 'warn');
    for (const id of [
      'filesystem.root',
      'filesystem.run',
      'filesystem.logs',
      'filesystem.transcripts',
      'filesystem.workspace',
      'configuration.settings',
      'configuration.slack_credentials',
      'configuration.backend',
      'workspace.path',
      'workspace.prompt.soul',
      'workspace.prompt.agents',
      'workspace.prompt.user',
      'workspace.prompt.memory',
    ]) {
      assert.equal(report.checks.find((check) => check.id === id)?.status, 'pass', id);
    }
    assert.doesNotMatch(result.stdout + result.stderr, /local-fixture/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('doctor inspects real SQLite database, WAL, and SHM artifacts', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-sqlite-'));
  const home = createSkyHome({ homeDir });
  prepareSkyHome(home);
  await writeFile(
    home.settingsFile,
    JSON.stringify({
      slack: { botToken: 'xoxb-sqlite-secret', appToken: 'xapp-sqlite-secret' },
      model: 'anthropic/test-model',
      agentBackend: 'claude-agent-sdk',
      claudeAgentSdk: { oauthToken: 'oauth-sqlite-secret' },
    }),
    { mode: 0o600 },
  );
  for (const name of ['SOUL.md', 'AGENTS.md', 'USER.md', 'MEMORY.md']) {
    await writeFile(path.join(home.workspaceDir, name), `${name}\n`, { mode: 0o600 });
  }
  const store = openConversationStore(home);
  try {
    store.put('doctor-thread', {
      sessionId: 'doctor-session',
      backend: 'pi',
      model: 'anthropic/test-model',
      agentName: 'main',
    });
    const result = await runCli(['doctor', '--json'], { ...process.env, HOME: homeDir });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    for (const id of ['filesystem.database', 'filesystem.database_wal', 'filesystem.database_shm']) {
      assert.equal(report.checks.find((check) => check.id === id)?.status, 'pass', id);
    }
    assert.doesNotMatch(result.stdout, /sqlite-secret/);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

// Load-bearing permission invariant: simulate a different process identity at the diagnostics seam.
test('diagnostics reject managed entries owned by a different user identity', async (t) => {
  if (!process.getuid) {
    t.skip('POSIX ownership is unavailable');
    return;
  }
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-owner-'));
  const home = createSkyHome({ homeDir });
  prepareSkyHome(home);
  await writeFile(
    home.settingsFile,
    JSON.stringify({
      slack: { botToken: 'xoxb-owner-secret', appToken: 'xapp-owner-secret' },
      model: 'anthropic/test-model',
      agentBackend: 'claude-agent-sdk',
      claudeAgentSdk: { oauthToken: 'oauth-owner-secret' },
    }),
    { mode: 0o600 },
  );
  const getuid = process.getuid;
  process.getuid = () => getuid() + 1;
  try {
    const report = await runDiagnostics(home, { homeDir });
    const settings = report.checks.find((check) => check.id === 'filesystem.settings');
    assert.equal(settings.status, 'fail');
    assert.match(settings.summary, /another user/);
    assert.doesNotMatch(JSON.stringify(report), /owner-secret/);
  } finally {
    process.getuid = getuid;
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('doctor distinguishes unsafe SQLite state and workspace prompt failures without leaking content', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-failures-'));
  const skyHome = path.join(homeDir, '.sky');
  const workspace = path.join(skyHome, 'workspace');
  try {
    for (const directory of [
      skyHome,
      path.join(skyHome, 'run'),
      path.join(skyHome, 'logs'),
      path.join(skyHome, 'transcripts'),
      workspace,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    await writeFile(
      path.join(skyHome, 'settings.json'),
      JSON.stringify({
        slack: { botToken: 'xoxb-never-print-this', appToken: 'xapp-never-print-this' },
        model: 'anthropic/test-model',
        agentBackend: 'claude-agent-sdk',
        claudeAgentSdk: { oauthToken: 'oauth-never-print-this' },
        workspace,
      }),
      { mode: 0o600 },
    );
    await writeFile(path.join(skyHome, 'logs', 'skyd.jsonl'), '', { mode: 0o600 });
    await writeFile(path.join(skyHome, 'logs', 'launchd.stdout.log'), '', { mode: 0o600 });
    await writeFile(path.join(skyHome, 'logs', 'launchd.stderr.log'), '', { mode: 0o600 });
    await writeFile(path.join(skyHome, 'sky.db-wal'), 'sqlite fixture', { mode: 0o644 });
    await chmod(path.join(skyHome, 'sky.db-wal'), 0o644);
    await symlink('missing-soul.md', path.join(workspace, 'SOUL.md'));
    await symlink('AGENTS.md', path.join(workspace, 'AGENTS.md'));
    await mkdir(path.join(workspace, 'USER.md'));
    await writeFile(path.join(workspace, 'MEMORY.md'), '   \n', { mode: 0o600 });

    const env = { ...process.env, HOME: homeDir };
    const result = await runCli(['doctor', '--json'], env);
    assert.equal(result.code, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.overall, 'fail');
    assert.equal(report.checks.find((check) => check.id === 'filesystem.database_wal')?.status, 'fail');
    assert.match(
      report.checks.find((check) => check.id === 'workspace.prompt.soul')?.summary ?? '',
      /broken symlink/,
    );
    assert.match(
      report.checks.find((check) => check.id === 'workspace.prompt.agents')?.summary ?? '',
      /symlink cycle/,
    );
    assert.match(
      report.checks.find((check) => check.id === 'workspace.prompt.user')?.summary ?? '',
      /regular file/,
    );
    assert.equal(report.checks.find((check) => check.id === 'workspace.prompt.memory')?.status, 'warn');
    assert.doesNotMatch(result.stdout + result.stderr, /never-print-this|sqlite fixture/);

    const human = await runCli(['doctor'], env);
    assert.equal(human.code, 1);
    assert.match(human.stdout, /FAIL filesystem\.database_wal/);
    assert.match(human.stdout, /FAIL workspace\.prompt\.soul/);
    assert.doesNotMatch(human.stdout + human.stderr, /never-print-this|sqlite fixture/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('daemon diagnostics report a disk and active configuration mismatch as restart-required', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-revision-'));
  const skyHome = path.join(homeDir, '.sky');
  const workspace = path.join(skyHome, 'workspace');
  await mkdir(workspace, { recursive: true });
  const settingsFile = path.join(skyHome, 'settings.json');
  const settings = {
    slack: { botToken: 'xoxb-revision-secret', appToken: 'xapp-revision-secret' },
    model: 'anthropic/model-before-restart',
    agentBackend: 'claude-agent-sdk',
    claudeAgentSdk: { oauthToken: 'oauth-revision-secret' },
    workspace,
  };
  await writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });
  for (const name of ['SOUL.md', 'AGENTS.md', 'USER.md', 'MEMORY.md']) {
    await writeFile(path.join(workspace, name), `${name}\n`, { mode: 0o600 });
  }

  const daemon = await startSkyd({
    homeDir,
    startRuntime: async () => ({ close: async () => {} }),
  });
  try {
    await waitForRuntime(daemon.paths.socketFile, 'ready');
    await writeFile(
      settingsFile,
      JSON.stringify({ ...settings, model: 'anthropic/model-after-restart' }),
    );

    const result = await runCli(['doctor', '--json'], { ...process.env, HOME: homeDir });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    const revision = report.checks.find((check) => check.id === 'configuration.revision');
    assert.equal(revision.status, 'warn');
    assert.match(revision.detail, /restart is required/i);
    assert.doesNotMatch(result.stdout, /revision-secret/);
  } finally {
    await daemon.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('daemon diagnostics preserve needs-configuration, degraded, and draining runtime semantics', async (t) => {
  await t.test('needs_configuration', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-needs-config-'));
    const daemon = await startSkyd({ homeDir });
    try {
      await waitForRuntime(daemon.paths.socketFile, 'needs_configuration');
      const result = await runCli(['doctor', '--json'], { ...process.env, HOME: homeDir });
      assert.equal(result.code, 1);
      const report = JSON.parse(result.stdout);
      assert.equal(report.mode, 'daemon');
      assert.equal(report.checks.find((check) => check.id === 'runtime.state')?.status, 'fail');
    } finally {
      await daemon.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  await t.test('degraded', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-degraded-'));
    const skyHome = path.join(homeDir, '.sky');
    await mkdir(skyHome, { recursive: true });
    await writeFile(
      path.join(skyHome, 'settings.json'),
      JSON.stringify({
        slack: { botToken: 'xoxb-degraded-secret', appToken: 'xapp-degraded-secret' },
        model: 'anthropic/test-model',
        agentBackend: 'claude-agent-sdk',
        claudeAgentSdk: { oauthToken: 'oauth-degraded-secret' },
      }),
      { mode: 0o600 },
    );
    const daemon = await startSkyd({
      homeDir,
      backoff: { baseMs: 1_000, maxMs: 1_000, jitterRatio: 0 },
      startRuntime: async () => {
        throw new SlackStartupError(new Error('external Slack failure'));
      },
    });
    try {
      await waitForRuntime(daemon.paths.socketFile, 'degraded');
      const result = await runCli(['doctor', '--json'], { ...process.env, HOME: homeDir });
      assert.equal(result.code, 1);
      const report = JSON.parse(result.stdout);
      assert.equal(report.checks.find((check) => check.id === 'runtime.state')?.status, 'fail');
      assert.equal(report.checks.find((check) => check.id === 'runtime.slack')?.status, 'warn');
      assert.match(
        report.checks.find((check) => check.id === 'runtime.errors')?.summary ?? '',
        /slack_startup_failed/,
      );
      assert.doesNotMatch(result.stdout, /degraded-secret/);
    } finally {
      await daemon.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  await t.test('draining', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-draining-'));
    const skyHome = path.join(homeDir, '.sky');
    const workspace = path.join(skyHome, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(skyHome, 'settings.json'),
      JSON.stringify({
        slack: { botToken: 'xoxb-draining-secret', appToken: 'xapp-draining-secret' },
        model: 'anthropic/test-model',
        agentBackend: 'claude-agent-sdk',
        claudeAgentSdk: { oauthToken: 'oauth-draining-secret' },
        workspace,
      }),
      { mode: 0o600 },
    );
    for (const name of ['SOUL.md', 'AGENTS.md', 'USER.md', 'MEMORY.md']) {
      await writeFile(path.join(workspace, name), `${name}\n`, { mode: 0o600 });
    }
    let releaseClose;
    const closeGate = new Promise((resolve) => {
      releaseClose = resolve;
    });
    const daemon = await startSkyd({
      homeDir,
      startRuntime: async () => ({ close: async () => closeGate }),
    });
    await waitForRuntime(daemon.paths.socketFile, 'ready');
    const closing = daemon.close();
    try {
      const result = await runCli(['doctor', '--json'], { ...process.env, HOME: homeDir });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const report = JSON.parse(result.stdout);
      assert.equal(report.checks.find((check) => check.id === 'runtime.state')?.status, 'warn');
      assert.match(
        report.checks.find((check) => check.id === 'runtime.state')?.summary ?? '',
        /draining/,
      );
    } finally {
      releaseClose();
      await closing;
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

test('doctor reserves exit 2 for a daemon diagnostics internal error', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-internal-'));
  const runDir = path.join(homeDir, '.sky', 'run');
  const socketFile = path.join(runDir, 'skyd.sock');
  await mkdir(runDir, { recursive: true });
  const server = http.createServer((_request, response) => {
    const body = JSON.stringify({ error: { code: 'internal_error' } });
    response.writeHead(500, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketFile, resolve);
  });
  try {
    const result = await runCli(['doctor', '--json'], { ...process.env, HOME: homeDir });
    assert.equal(result.code, 2, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      error: { code: 'diagnostics_internal_error', message: 'Diagnostics could not run.' },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('doctor identifies an unsupported settings schema without echoing the document', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-schema-'));
  const home = createSkyHome({ homeDir });
  prepareSkyHome(home);
  try {
    await writeFile(
      home.settingsFile,
      JSON.stringify({ schemaVersion: 999, revision: 7, marker: 'schema-never-print-this' }),
      { mode: 0o600 },
    );
    const result = await runCli(['doctor', '--json'], { ...process.env, HOME: homeDir });
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checks.find((check) => check.id === 'configuration.settings')?.status, 'fail');
    assert.match(
      report.checks.find((check) => check.id === 'configuration.schema')?.summary ?? '',
      /unsupported/,
    );
    assert.doesNotMatch(result.stdout + result.stderr, /schema-never-print-this|revision.*7/i);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('doctor distinguishes a valid settings document from missing secrets', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-missing-secrets-'));
  const home = createSkyHome({ homeDir });
  prepareSkyHome(home);
  try {
    await writeFile(
      home.settingsFile,
      JSON.stringify({
        schemaVersion: 1,
        revision: 3,
        agentBackend: 'pi',
        model: 'anthropic/test-model',
        workspace: home.workspaceDir,
      }),
      { mode: 0o600 },
    );

    const report = await runDiagnostics(home, { homeDir });

    assert.equal(report.checks.find((check) => check.id === 'configuration.settings')?.status, 'pass');
    assert.equal(
      report.checks.find((check) => check.id === 'configuration.slack_credentials')?.status,
      'fail',
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('local fallback does not create Pi credential or model cache files while diagnosing them', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-pi-readonly-'));
  const home = createSkyHome({ homeDir });
  prepareSkyHome(home);
  try {
    await writeFile(
      home.settingsFile,
      JSON.stringify({
        slack: { botToken: 'xoxb-pi-secret', appToken: 'xapp-pi-secret' },
        model: 'anthropic/claude-sonnet-4-5',
        agentBackend: 'pi',
      }),
      { mode: 0o600 },
    );
    await runCli(['doctor', '--json'], { ...process.env, HOME: homeDir });
    await assert.rejects(stat(path.join(homeDir, '.pi')), { code: 'ENOENT' });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('doctor does not follow an unsafe settings symlink', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-settings-link-'));
  const home = createSkyHome({ homeDir });
  prepareSkyHome(home);
  const outside = path.join(homeDir, 'outside-settings.json');
  try {
    await writeFile(
      outside,
      JSON.stringify({
        slack: { botToken: 'xoxb-symlink-secret', appToken: 'xapp-symlink-secret' },
        model: 'anthropic/test-model',
      }),
      { mode: 0o600 },
    );
    await symlink(outside, home.settingsFile);
    const result = await runCli(['doctor', '--json'], { ...process.env, HOME: homeDir });
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    const settings = report.checks.find((check) => check.id === 'configuration.settings');
    assert.equal(settings.status, 'fail');
    assert.match(settings.summary, /unsafe and were not read/);
    assert.doesNotMatch(result.stdout + result.stderr, /symlink-secret/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('doctor detects a LaunchAgent configured for a different Sky home', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('LaunchAgent diagnostics are macOS-specific');
    return;
  }
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-plist-'));
  const home = createSkyHome({ homeDir });
  prepareSkyHome(home);
  try {
    await writeFile(
      home.settingsFile,
      JSON.stringify({
        slack: { botToken: 'xoxb-plist-secret', appToken: 'xapp-plist-secret' },
        model: 'anthropic/test-model',
        agentBackend: 'claude-agent-sdk',
        claudeAgentSdk: { oauthToken: 'oauth-plist-secret' },
      }),
      { mode: 0o600 },
    );
    for (const name of ['SOUL.md', 'AGENTS.md', 'USER.md', 'MEMORY.md']) {
      await writeFile(path.join(home.workspaceDir, name), `${name}\n`, { mode: 0o600 });
    }
    const launchAgents = path.join(homeDir, 'Library', 'LaunchAgents');
    await mkdir(launchAgents, { recursive: true });
    await writeFile(
      path.join(launchAgents, 'com.ty91.skyd.plist'),
      `<plist><dict><key>EnvironmentVariables</key><dict><key>SKY_HOME</key><string>${path.join(homeDir, 'wrong-sky-home')}</string></dict></dict></plist>`,
      { mode: 0o600 },
    );

    const result = await runCli(['doctor', '--json'], { ...process.env, HOME: homeDir });
    assert.equal(result.code, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    const root = report.checks.find((check) => check.id === 'installation.sky_home');
    assert.equal(root.status, 'fail');
    assert.match(root.summary, /different Sky homes/);
    assert.doesNotMatch(result.stdout, /plist-secret/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('doctor distinguishes workspace root symlink, type, and permission failures', async (t) => {
  const cases = [
    {
      name: 'broken symlink',
      setup: (workspace) => symlink('missing-workspace', workspace),
      expected: /broken symlink/,
    },
    {
      name: 'symlink cycle',
      setup: (workspace) => symlink(path.basename(workspace), workspace),
      expected: /symlink cycle/,
    },
    {
      name: 'non-directory target',
      setup: (workspace) => writeFile(workspace, 'not a directory'),
      expected: /does not resolve to a directory/,
    },
    {
      name: 'permission error',
      setup: async (workspace) => {
        await mkdir(workspace, { mode: 0o000 });
        await chmod(workspace, 0o000);
      },
      expected: /permission error/,
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-doctor-workspace-'));
      const home = createSkyHome({ homeDir });
      prepareSkyHome(home);
      const workspace = path.join(homeDir, 'configured-workspace');
      try {
        await candidate.setup(workspace);
        await writeFile(
          home.settingsFile,
          JSON.stringify({
            slack: { botToken: 'xoxb-workspace-secret', appToken: 'xapp-workspace-secret' },
            model: 'anthropic/test-model',
            agentBackend: 'claude-agent-sdk',
            claudeAgentSdk: { oauthToken: 'oauth-workspace-secret' },
            workspace,
          }),
          { mode: 0o600 },
        );
        const result = await runCli(['doctor', '--json'], { ...process.env, HOME: homeDir });
        assert.equal(result.code, 1, result.stderr || result.stdout);
        const report = JSON.parse(result.stdout);
        const workspaceCheck = report.checks.find((check) => check.id === 'workspace.path');
        assert.equal(workspaceCheck.status, 'fail');
        assert.match(workspaceCheck.summary, candidate.expected);
        assert.doesNotMatch(result.stdout, /workspace-secret/);
      } finally {
        try {
          await chmod(workspace, 0o700);
        } catch {
          // Symlinks and regular files do not need permission restoration for cleanup.
        }
        await rm(homeDir, { recursive: true, force: true });
      }
    });
  }
});
