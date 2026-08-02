import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SkyHomeConfigurationError,
  UnsafeSkyPathError,
  createSkyHome,
  ensurePrivateFile,
  prepareSkyHome,
} from '../dist/sky-home.js';
import { startSkyd } from '../dist/skyd/app.js';
import { createJsonlLogger } from '../dist/skyd/logger.js';
import { loadSettings } from '../dist/settings.js';
import { openConversationStore } from '../dist/conversation/store.js';
import { TranscriptWriter } from '../dist/agents/memory/transcript.js';
import {
  advanceCursors,
  getUnreadTranscripts,
} from '../dist/agents/memory/cursors.js';

function permissions(file) {
  return lstatSync(file).mode & 0o777;
}

// Direct filesystem assertions are intentional: path ownership and permission modes are
// load-bearing security invariants that are difficult to diagnose through daemon status alone.

function withTempRoot(run) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'sky-home-'));
  try {
    return run(path.join(tempDir, 'custom-sky'), tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function withTempRootAsync(run) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'sky-home-'));
  try {
    await run(path.join(tempDir, 'custom-sky'), tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('SkyHome resolves every managed path from the default and overridden root', () => {
  const homeDir = path.join(path.parse(process.cwd()).root, 'users', 'sky-test');
  const defaultHome = createSkyHome({ homeDir, env: {} });

  assert.deepEqual(defaultHome, {
    rootDir: path.join(homeDir, '.sky'),
    settingsFile: path.join(homeDir, '.sky', 'settings.json'),
    secretsFile: path.join(homeDir, '.sky', 'secrets.json'),
    runDir: path.join(homeDir, '.sky', 'run'),
    socketFile: path.join(homeDir, '.sky', 'run', 'skyd.sock'),
    logsDir: path.join(homeDir, '.sky', 'logs'),
    logFile: path.join(homeDir, '.sky', 'logs', 'skyd.jsonl'),
    launchdStderrFile: path.join(homeDir, '.sky', 'logs', 'launchd.stderr.log'),
    databaseFile: path.join(homeDir, '.sky', 'sky.db'),
    databaseWalFile: path.join(homeDir, '.sky', 'sky.db-wal'),
    databaseShmFile: path.join(homeDir, '.sky', 'sky.db-shm'),
    transcriptsDir: path.join(homeDir, '.sky', 'transcripts'),
    memoryCursorFile: path.join(homeDir, '.sky', 'memory-cursors.json'),
    workspaceDir: path.join(homeDir, '.sky', 'workspace'),
    legacyPidFile: path.join(homeDir, '.sky', 'sky.pid'),
    legacyLogFile: path.join(homeDir, '.sky', 'sky.log'),
    migratedLegacyLogFile: path.join(homeDir, '.sky', 'logs', 'legacy-sky.log'),
    source: 'default',
  });
  assert.equal(Object.isFrozen(defaultHome), true);

  const environmentRoot = path.join(homeDir, 'environment-sky');
  const environmentHome = createSkyHome({
    homeDir,
    env: { SKY_HOME: environmentRoot },
  });
  assert.equal(environmentHome.rootDir, environmentRoot);
  assert.equal(environmentHome.socketFile, path.join(environmentRoot, 'run', 'skyd.sock'));
  assert.equal(environmentHome.source, 'override');

  const explicitRoot = path.join(homeDir, 'explicit-sky');
  assert.equal(
    createSkyHome({ rootDir: explicitRoot, homeDir, env: { SKY_HOME: environmentRoot } }).rootDir,
    explicitRoot,
  );
});

test('SkyHome rejects empty, relative, and NUL-containing roots with a stable error', () => {
  const invalidRoots = ['', 'relative/sky', `bad${String.fromCharCode(0)}root`];

  for (const rootDir of invalidRoots) {
    assert.throws(
      () => createSkyHome({ env: { SKY_HOME: rootDir } }),
      (error) => {
        assert.ok(error instanceof SkyHomeConfigurationError);
        assert.equal(error.code, 'sky_home_invalid');
        return true;
      },
    );
  }

  assert.throws(
    () => createSkyHome({ rootDir: 'relative/explicit', env: {} }),
    (error) => error instanceof SkyHomeConfigurationError && error.code === 'sky_home_invalid',
  );
});

test('SkyHome defaults to the current OS home when no inputs are supplied', () => {
  assert.equal(createSkyHome().rootDir, path.join(os.homedir(), '.sky'));
});

test('SkyHome prepares and repairs private managed directories and files', () => {
  withTempRoot((rootDir) => {
    const home = createSkyHome({ rootDir });
    mkdirSync(path.join(home.transcriptsDir, 'C123'), { recursive: true, mode: 0o777 });
    mkdirSync(home.runDir, { mode: 0o777 });
    mkdirSync(home.logsDir, { mode: 0o777 });
    mkdirSync(home.workspaceDir, { mode: 0o777 });

    const managedFiles = [
      home.secretsFile,
      home.databaseFile,
      home.databaseWalFile,
      home.databaseShmFile,
      home.memoryCursorFile,
      home.logFile,
      home.launchdStderrFile,
      path.join(home.transcriptsDir, 'C123', 'session.md'),
    ];
    for (const file of managedFiles) {
      writeFileSync(file, 'private', { mode: 0o666 });
      chmodSync(file, 0o666);
    }

    prepareSkyHome(home);

    for (const directory of [
      home.rootDir,
      home.runDir,
      home.logsDir,
      home.transcriptsDir,
      path.join(home.transcriptsDir, 'C123'),
      home.workspaceDir,
    ]) {
      assert.equal(permissions(directory), 0o700, directory);
    }
    for (const file of managedFiles) {
      assert.equal(permissions(file), 0o600, file);
    }
  });
});

test('SkyHome creates its private directory contract and log files from scratch', () => {
  withTempRoot((rootDir) => {
    const home = createSkyHome({ rootDir });
    prepareSkyHome(home);

    for (const directory of [
      home.rootDir,
      home.runDir,
      home.logsDir,
      home.transcriptsDir,
      home.workspaceDir,
    ]) {
      assert.equal(permissions(directory), 0o700, directory);
    }
    assert.equal(permissions(home.logFile), 0o600);
    assert.equal(permissions(home.launchdStderrFile), 0o600);
  });
});

test('SkyHome refuses symlinks and wrong managed entry types without changing their targets', () => {
  withTempRoot((rootDir, tempDir) => {
    const home = createSkyHome({ rootDir });
    mkdirSync(rootDir, { mode: 0o700 });
    const target = path.join(tempDir, 'target.json');
    writeFileSync(target, '{}', { mode: 0o644 });
    chmodSync(target, 0o644);
    symlinkSync(target, home.secretsFile);

    assert.throws(
      () => prepareSkyHome(home),
      (error) => error instanceof UnsafeSkyPathError && error.code === 'unsafe_sky_path',
    );
    assert.equal(permissions(target), 0o644);
    assert.equal(lstatSync(home.secretsFile).isSymbolicLink(), true);
  });

  withTempRoot((rootDir) => {
    const home = createSkyHome({ rootDir });
    mkdirSync(rootDir, { mode: 0o700 });
    writeFileSync(home.runDir, 'not a directory');

    assert.throws(
      () => prepareSkyHome(home),
      (error) => error instanceof UnsafeSkyPathError && error.code === 'unsafe_sky_path',
    );
  });
});

test('SkyHome refuses a symlink root without modifying the target directory', () => {
  withTempRoot((rootDir, tempDir) => {
    const target = path.join(tempDir, 'target-directory');
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync(target, rootDir);

    assert.throws(
      () => prepareSkyHome(createSkyHome({ rootDir })),
      (error) => error instanceof UnsafeSkyPathError && error.code === 'unsafe_sky_path',
    );
    assert.equal(permissions(target), 0o755);
  });
});

test('SkyHome refuses a managed file owned by a different user identity', (t) => {
  if (!process.getuid) {
    t.skip('POSIX ownership is unavailable');
    return;
  }

  withTempRoot((_rootDir, tempDir) => {
    const managedFile = path.join(tempDir, 'foreign-owned.json');
    writeFileSync(managedFile, '{}', { mode: 0o644 });
    chmodSync(managedFile, 0o644);
    const getuid = process.getuid;
    process.getuid = () => getuid() + 1;
    try {
      assert.throws(
        () => ensurePrivateFile(managedFile),
        (error) => error instanceof UnsafeSkyPathError && error.code === 'unsafe_sky_path',
      );
      assert.equal(permissions(managedFile), 0o644);
    } finally {
      process.getuid = getuid;
    }
  });
});

test('the daemon and settings loader consume one explicit SkyHome root end to end', async () => {
  await withTempRootAsync(async (rootDir) => {
    const home = createSkyHome({ rootDir });
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(
      home.settingsFile,
      JSON.stringify({
        slack: { botToken: 'xoxb-test', appToken: 'xapp-test' },
        model: 'anthropic/test-model',
      }),
      { mode: 0o644 },
    );
    const settings = loadSettings({ silent: true, skyHome: home });
    assert.equal(settings.workspace, home.workspaceDir);
    writeFileSync(home.settingsFile, '{ invalid json', { mode: 0o644 });

    const daemon = await startSkyd({ rootDir });
    try {
      assert.deepEqual(daemon.paths, home);
      assert.equal(process.umask(), 0o077);
      assert.equal(permissions(home.settingsFile), 0o600);
      assert.equal(permissions(home.socketFile), 0o600);
      assert.equal(permissions(home.logFile), 0o600);
    } finally {
      await daemon.close();
    }
  });
});

test('SQLite, transcript, and cursor writers preserve private files at their real paths', () => {
  withTempRoot((rootDir) => {
    const previousUmask = process.umask(0o022);
    const home = createSkyHome({ rootDir });
    prepareSkyHome(home);
    const store = openConversationStore(home);
    try {
      store.put('thread-1', {
        sessionId: 'session-1',
        backend: 'pi',
        model: 'anthropic/test-model',
        agentName: 'main',
      });
      for (const file of [home.databaseFile, home.databaseWalFile, home.databaseShmFile]) {
        assert.equal(permissions(file), 0o600, file);
      }

      const transcript = new TranscriptWriter('C123:123.456', home);
      transcript.appendUser('private message');
      transcript.setSessionId('session-1');
      const transcriptFile = path.join(
        home.transcriptsDir,
        'C123:123.456',
        'session-1.md',
      );
      assert.equal(permissions(path.dirname(transcriptFile)), 0o700);
      assert.equal(permissions(transcriptFile), 0o600);

      const unread = getUnreadTranscripts(home);
      assert.equal(unread.length, 1);
      advanceCursors(unread, home);
      assert.equal(permissions(home.memoryCursorFile), 0o600);
    } finally {
      store.close();
      process.umask(previousUmask);
    }
  });
});

test('the structured logger refuses a managed file replaced by a symlink', () => {
  withTempRoot((rootDir, tempDir) => {
    const home = createSkyHome({ rootDir });
    prepareSkyHome(home);
    const logger = createJsonlLogger(home.logFile);
    logger.log('info', 'test', 'before replacement');

    renameSync(home.logFile, `${home.logFile}.old`);
    const target = path.join(tempDir, 'outside.log');
    writeFileSync(target, 'outside\n', { mode: 0o644 });
    chmodSync(target, 0o644);
    symlinkSync(target, home.logFile);

    assert.throws(
      () => logger.log('info', 'test', 'must not escape'),
      (error) => error instanceof UnsafeSkyPathError && error.code === 'unsafe_sky_path',
    );
    assert.equal(permissions(target), 0o644);
  });
});
