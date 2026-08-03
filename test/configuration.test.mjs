import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspect } from 'node:util';
import { ConfigurationError, createConfiguration } from '../dist/configuration.js';
import { createSkyHome } from '../dist/sky-home.js';

// Direct configuration-interface tests against real temporary files are intentional: migration,
// durability, ownership, and secret non-disclosure are load-bearing security invariants.

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function permissions(stats) {
  return stats.mode & 0o777;
}

const migrationTime = () => new Date('2026-08-03T01:02:03.000Z');

async function withConfiguration(run) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'sky-configuration-'));
  const home = createSkyHome({ rootDir });
  try {
    await mkdir(home.workspaceDir, { recursive: true, mode: 0o700 });
    await run({ configuration: createConfiguration(home, { env: {} }), home });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function writeV1(home, overrides = {}) {
  await writeFile(
    home.settingsFile,
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      agentBackend: 'pi',
      model: 'anthropic/test-model',
      workspace: home.workspaceDir,
      ...overrides,
    }),
    { mode: 0o600 },
  );
}

async function writeSecrets(home, secrets) {
  const updatedAt = '2026-08-03T00:00:00.000Z';
  await writeFile(
    home.secretsFile,
    JSON.stringify({
      schemaVersion: 1,
      secrets: Object.fromEntries(
        Object.entries(secrets).map(([name, value]) => [name, { value, updatedAt }]),
      ),
    }),
    { mode: 0o600 },
  );
}

test('runtime resolution reports a stable secret-missing error without exposing configuration', async () => {
  await withConfiguration(async ({ configuration, home }) => {
    await writeV1(home);

    assert.throws(
      () => configuration.resolveRuntime(),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.code, 'secret_missing');
        assert.deepEqual(error.details, {});
        assert.equal(/settings|slack|token|anthropic/i.test(JSON.stringify(error)), false);
        return true;
      },
    );
  });
});

test('an empty Claude OAuth environment variable does not satisfy a required secret', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'sky-configuration-'));
  const home = createSkyHome({ rootDir });
  try {
    await mkdir(home.workspaceDir, { recursive: true, mode: 0o700 });
    await writeV1(home, { agentBackend: 'claude-agent-sdk' });
    await writeSecrets(home, {
      'slack.botToken': 'xoxb-stored-bot',
      'slack.appToken': 'xapp-stored-app',
    });
    const configuration = createConfiguration(home, {
      env: { CLAUDE_CODE_OAUTH_TOKEN: '' },
    });

    assert.throws(
      () => configuration.resolveRuntime(),
      (error) => error instanceof ConfigurationError && error.code === 'secret_missing',
    );
    assert.deepEqual(configuration.inspect().public.secrets['claudeAgentSdk.oauthToken'], {
      configured: false,
      source: null,
      updatedAt: null,
      displayHint: null,
    });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('legacy migration validates every credential before changing either document', async () => {
  await withConfiguration(async ({ configuration, home }) => {
    const invalidBotToken = 'legacy-invalid-bot-secret';
    const legacy = `${JSON.stringify({
      slack: { botToken: invalidBotToken, appToken: 'xapp-valid-secret' },
      model: 'anthropic/test-model',
      workspace: home.workspaceDir,
    })}\n`;
    await writeFile(home.settingsFile, legacy, { mode: 0o600 });

    assert.throws(
      () => configuration.resolveRuntime(),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.code, 'settings_invalid');
        assert.equal(JSON.stringify(error).includes(invalidBotToken), false);
        return true;
      },
    );
    assert.equal(digest(await readFile(home.settingsFile, 'utf8')), digest(legacy));
    await assert.rejects(stat(home.secretsFile), { code: 'ENOENT' });
  });
});

test('fresh v1 updates are private, revisioned, atomic, and return only public metadata', async () => {
  await withConfiguration(async ({ configuration, home }) => {
    const botToken = 'xoxb-fresh-secret-1111';
    const appToken = 'xapp-fresh-secret-2222';
    const configured = configuration.patch(0, {
      agentBackend: 'pi',
      model: 'anthropic/test-model',
      effort: 'high',
      workspace: home.workspaceDir,
    });
    assert.equal(configured.public.revision, 1);

    const settings = JSON.parse(await readFile(home.settingsFile, 'utf8'));
    assert.deepEqual(Object.keys(settings).toSorted(), [
      'agentBackend',
      'effort',
      'model',
      'revision',
      'schemaVersion',
      'workspace',
    ]);
    assert.equal(settings.schemaVersion, 1);
    assert.equal(settings.revision, 1);

    configuration.setSecret('slack.botToken', botToken);
    const snapshot = configuration.setSecret('slack.appToken', appToken).public;
    assert.equal(snapshot.complete, true);
    assert.deepEqual(snapshot.secrets['slack.botToken'], {
      configured: true,
      source: 'stored',
      updatedAt: snapshot.secrets['slack.botToken'].updatedAt,
      displayHint: 'xoxb-…1111',
    });
    assert.equal(JSON.stringify(snapshot).includes(botToken), false);
    assert.equal(JSON.stringify(snapshot).includes(appToken), false);

    const runtime = configuration.resolveRuntime();
    assert.equal(digest(runtime.settings.slack.botToken), digest(botToken));
    assert.equal(digest(runtime.settings.slack.appToken), digest(appToken));
    assert.equal(permissions(await lstat(home.settingsFile)), 0o600);
    assert.equal(permissions(await lstat(home.secretsFile)), 0o600);
    assert.equal((await readdir(home.rootDir)).some((name) => name.endsWith('.tmp')), false);

    const persisted = digest(await readFile(home.settingsFile, 'utf8'));
    assert.throws(
      () => configuration.patch(0, { model: 'anthropic/lost-update' }),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'revision_conflict' &&
        JSON.stringify(error.details).includes(botToken) === false &&
        JSON.stringify(error.details).includes(appToken) === false,
    );
    assert.throws(
      () => configuration.patch(1, { workspace: 'relative' }),
      (error) => error instanceof ConfigurationError && error.code === 'invalid_value',
    );
    assert.equal(digest(await readFile(home.settingsFile, 'utf8')), persisted);
  });
});

test('legacy migration moves credentials once and is idempotent on the next startup', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'sky-configuration-'));
  const home = createSkyHome({ rootDir });
  const botToken = 'xoxb-migration-secret-1111';
  const appToken = 'xapp-migration-secret-2222';
  const oauthToken = 'migration-oauth-secret';
  try {
    await mkdir(home.workspaceDir, { recursive: true, mode: 0o700 });
    await writeFile(
      home.settingsFile,
      JSON.stringify({
        slack: { botToken, appToken },
        claudeAgentSdk: { oauthToken },
        agentBackend: 'claude-agent-sdk',
        model: 'anthropic/test-model',
        effort: 'xhigh',
        workspace: home.workspaceDir,
      }),
      { mode: 0o600 },
    );
    const first = createConfiguration(home, { env: {}, now: migrationTime }).resolveRuntime();
    assert.equal(digest(first.settings.slack.botToken), digest(botToken));
    assert.equal(digest(first.settings.slack.appToken), digest(appToken));
    assert.equal(digest(first.settings.claudeAgentSdk.oauthToken), digest(oauthToken));

    const migratedSettings = JSON.parse(await readFile(home.settingsFile, 'utf8'));
    assert.deepEqual(Object.keys(migratedSettings).toSorted(), [
      'agentBackend',
      'effort',
      'model',
      'revision',
      'schemaVersion',
      'workspace',
    ]);
    assert.equal(migratedSettings.schemaVersion, 1);
    assert.equal(migratedSettings.revision, 1);
    const secretDocument = JSON.parse(await readFile(home.secretsFile, 'utf8'));
    assert.deepEqual(Object.keys(secretDocument.secrets).toSorted(), [
      'claudeAgentSdk.oauthToken',
      'slack.appToken',
      'slack.botToken',
    ]);
    assert.equal(digest(secretDocument.secrets['slack.botToken'].value), digest(botToken));
    assert.equal(digest(secretDocument.secrets['slack.appToken'].value), digest(appToken));
    assert.equal(
      digest(secretDocument.secrets['claudeAgentSdk.oauthToken'].value),
      digest(oauthToken),
    );

    const settingsAfterMigration = digest(await readFile(home.settingsFile, 'utf8'));
    const secretsAfterMigration = digest(await readFile(home.secretsFile, 'utf8'));
    createConfiguration(home, {
      env: {},
      now: () => new Date('2026-08-04T00:00:00.000Z'),
    }).resolveRuntime();
    assert.equal(digest(await readFile(home.settingsFile, 'utf8')), settingsAfterMigration);
    assert.equal(digest(await readFile(home.secretsFile, 'utf8')), secretsAfterMigration);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('migration recovers after the secret-write step and preserves matching stored metadata', async () => {
  await withConfiguration(async ({ home }) => {
    const botToken = 'xoxb-recovery-secret-1111';
    const appToken = 'xapp-recovery-secret-2222';
    const updatedAt = '2026-08-02T00:00:00.000Z';
    await writeFile(
      home.settingsFile,
      JSON.stringify({
        slack: { botToken, appToken },
        model: 'anthropic/test-model',
        workspace: home.workspaceDir,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      home.secretsFile,
      JSON.stringify({
        schemaVersion: 1,
        secrets: {
          'slack.botToken': { value: botToken, updatedAt },
          'slack.appToken': { value: appToken, updatedAt },
        },
      }),
      { mode: 0o600 },
    );
    const secretState = digest(await readFile(home.secretsFile, 'utf8'));

    createConfiguration(home, { env: {} }).resolveRuntime();

    assert.equal(digest(await readFile(home.secretsFile, 'utf8')), secretState);
    const settings = JSON.parse(await readFile(home.settingsFile, 'utf8'));
    assert.equal(settings.schemaVersion, 1);
    assert.equal(settings.revision, 1);
  });
});

test('a legacy secret conflict leaves both documents byte-for-byte unchanged', async () => {
  await withConfiguration(async ({ home }) => {
    const legacyBotToken = 'xoxb-legacy-secret-1111';
    const storedBotToken = 'xoxb-stored-secret-9999';
    const appToken = 'xapp-shared-secret-2222';
    await writeFile(
      home.settingsFile,
      JSON.stringify({
        slack: { botToken: legacyBotToken, appToken },
        model: 'anthropic/test-model',
        workspace: home.workspaceDir,
      }),
      { mode: 0o600 },
    );
    await writeSecrets(home, {
      'slack.botToken': storedBotToken,
      'slack.appToken': appToken,
    });
    const settingsBefore = digest(await readFile(home.settingsFile, 'utf8'));
    const secretsBefore = digest(await readFile(home.secretsFile, 'utf8'));

    assert.throws(
      () => createConfiguration(home, { env: {} }).resolveRuntime(),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.code, 'migration_conflict');
        const serialized = JSON.stringify(error);
        assert.equal(serialized.includes(legacyBotToken), false);
        assert.equal(serialized.includes(storedBotToken), false);
        return true;
      },
    );
    assert.equal(digest(await readFile(home.settingsFile, 'utf8')), settingsBefore);
    assert.equal(digest(await readFile(home.secretsFile, 'utf8')), secretsBefore);
  });
});

test('the environment OAuth token wins without making stored deletion look effective', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'sky-configuration-'));
  const home = createSkyHome({ rootDir });
  const storedOauth = 'stored-oauth-secret';
  const environmentOauth = 'environment-oauth-secret';
  try {
    await mkdir(home.workspaceDir, { recursive: true, mode: 0o700 });
    await writeV1(home, { agentBackend: 'claude-agent-sdk' });
    await writeSecrets(home, {
      'slack.botToken': 'xoxb-environment-bot',
      'slack.appToken': 'xapp-environment-app',
      'claudeAgentSdk.oauthToken': storedOauth,
    });
    const configuration = createConfiguration(home, {
      env: { CLAUDE_CODE_OAUTH_TOKEN: environmentOauth },
    });

    assert.equal(
      digest(configuration.resolveRuntime().settings.claudeAgentSdk.oauthToken),
      digest(environmentOauth),
    );
    assert.deepEqual(configuration.inspect().public.secrets['claudeAgentSdk.oauthToken'], {
      configured: true,
      source: 'environment',
      updatedAt: null,
      displayHint: null,
    });
    const afterDelete = configuration.deleteSecret('claudeAgentSdk.oauthToken').public;
    assert.deepEqual(afterDelete.secrets['claudeAgentSdk.oauthToken'], {
      configured: true,
      source: 'environment',
      updatedAt: null,
      displayHint: null,
    });
    assert.equal(
      Object.hasOwn(JSON.parse(await readFile(home.secretsFile, 'utf8')).secrets, 'claudeAgentSdk.oauthToken'),
      false,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('secure-file writes refuse symlink and foreign-owned targets without changing them', async (t) => {
  if (!process.getuid) {
    t.skip('POSIX ownership is unavailable');
    return;
  }
  await withConfiguration(async ({ home }) => {
    await writeV1(home);
    const target = path.join(home.rootDir, 'outside-secrets.json');
    const targetContents = '{"preserved":true}\n';
    await writeFile(target, targetContents, { mode: 0o600 });
    await symlink(target, home.secretsFile);
    const configuration = createConfiguration(home, { env: {} });

    assert.throws(
      () => configuration.setSecret('slack.botToken', 'xoxb-symlink-secret'),
      (error) => error instanceof ConfigurationError && error.code === 'secrets_unsafe',
    );
    assert.equal(digest(await readFile(target, 'utf8')), digest(targetContents));
    assert.equal((await lstat(home.secretsFile)).isSymbolicLink(), true);

    await rm(home.secretsFile);
    await writeFile(home.secretsFile, '{"schemaVersion":1,"secrets":{}}', { mode: 0o640 });
    await chmod(home.secretsFile, 0o640);
    const getuid = process.getuid;
    process.getuid = () => getuid() + 1;
    try {
      assert.throws(
        () => configuration.setSecret('slack.botToken', 'xoxb-foreign-secret'),
        (error) => error instanceof ConfigurationError && error.code === 'secrets_unsafe',
      );
      assert.equal(permissions(await lstat(home.secretsFile)), 0o640);
    } finally {
      process.getuid = getuid;
    }
  });
});

test('configuration errors do not retain malformed input containing a secret', async () => {
  await withConfiguration(async ({ home }) => {
    const malformedSecret = 'secret-never-retain';
    await writeV1(home);
    await writeFile(home.secretsFile, malformedSecret, { mode: 0o600 });

    assert.throws(
      () => createConfiguration(home, { env: {} }).inspect(),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.code, 'secrets_invalid');
        assert.equal(inspect(error, { depth: 10 }).includes(malformedSecret), false);
        return true;
      },
    );
  });
});
