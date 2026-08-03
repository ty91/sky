import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  buildSlackAppManifest,
  missingSlackBotScopes,
  serializeSlackAppManifest,
  slackAppCreateUrl,
  slackManifestRemediation,
  DEFAULT_SUGGESTED_PROMPTS,
  REQUIRED_SLACK_BOT_EVENTS,
  REQUIRED_SLACK_BOT_SCOPES,
  SLACK_BOT_EVENT_REASONS,
  SLACK_BOT_SCOPE_REASONS,
} from '../dist/slack/manifest.js';
import { REQUIRED_SLACK_BOT_SCOPES as SCOPES_VIA_CONNECTIONS } from '../dist/connections.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const skyEntrypoint = path.join(repositoryRoot, 'dist', 'index.js');
const manifestFile = path.join(repositoryRoot, 'slack-app-manifest.json');

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [skyEntrypoint, ...args], {
      encoding: 'utf8',
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

test('the checked-in manifest matches its TypeScript source', async () => {
  const onDisk = await readFile(manifestFile, 'utf8');
  assert.equal(
    onDisk,
    serializeSlackAppManifest(),
    'slack-app-manifest.json is stale; run `pnpm manifest:sync`.',
  );
});

test('the connection check and the manifest share one scope list', () => {
  assert.deepEqual([...SCOPES_VIA_CONNECTIONS], [...REQUIRED_SLACK_BOT_SCOPES]);
  assert.deepEqual(buildSlackAppManifest().oauth_config.scopes.bot, [...REQUIRED_SLACK_BOT_SCOPES]);
  assert.deepEqual(buildSlackAppManifest().settings.event_subscriptions.bot_events, [
    ...REQUIRED_SLACK_BOT_EVENTS,
  ]);
});

test('every required scope and event is justified and sorted', () => {
  assert.deepEqual([...REQUIRED_SLACK_BOT_SCOPES], REQUIRED_SLACK_BOT_SCOPES.toSorted());
  assert.deepEqual([...REQUIRED_SLACK_BOT_EVENTS], REQUIRED_SLACK_BOT_EVENTS.toSorted());
  assert.deepEqual(Object.keys(SLACK_BOT_SCOPE_REASONS).toSorted(), [...REQUIRED_SLACK_BOT_SCOPES]);
  assert.deepEqual(Object.keys(SLACK_BOT_EVENT_REASONS).toSorted(), [...REQUIRED_SLACK_BOT_EVENTS]);
  for (const reason of Object.values(SLACK_BOT_SCOPE_REASONS)) assert.ok(reason.length > 0);
  for (const reason of Object.values(SLACK_BOT_EVENT_REASONS)) assert.ok(reason.length > 0);
});

test('the scope list covers the Slack Web API methods Sky calls', () => {
  // Regression guard for the scopes that were missing while the list was
  // hand-maintained in two places.
  for (const scope of ['assistant:write', 'users:read', 'files:read']) {
    assert.ok(REQUIRED_SLACK_BOT_SCOPES.includes(scope), `${scope} must stay required`);
  }
});

test('the manifest declares the agent messaging experience over Socket Mode', () => {
  const manifest = buildSlackAppManifest();
  assert.equal(manifest.settings.socket_mode_enabled, true);
  assert.equal(manifest.settings.event_subscriptions.request_url, undefined);
  assert.ok(manifest.features.agent_view.agent_description.length > 0);
  assert.ok(manifest.features.agent_view.agent_description.length <= 300);
  assert.equal(manifest.features.assistant_view, undefined);
  assert.equal(manifest.features.app_home.messages_tab_enabled, true);
  assert.equal(manifest.features.app_home.messages_tab_read_only_enabled, false);
  assert.ok(manifest.display_information.description.length <= 140);
  assert.deepEqual(
    manifest.features.agent_view.suggested_prompts,
    DEFAULT_SUGGESTED_PROMPTS.map((prompt) => ({ ...prompt })),
  );
});

test('the create-from-manifest deep link round-trips the manifest', () => {
  const manifest = buildSlackAppManifest();
  const url = new URL(slackAppCreateUrl(manifest));
  assert.equal(url.origin + url.pathname, 'https://api.slack.com/apps');
  assert.equal(url.searchParams.get('new_app'), '1');
  assert.deepEqual(JSON.parse(url.searchParams.get('manifest_json')), manifest);
});

test('missing scopes are reported against the granted set', () => {
  assert.deepEqual(missingSlackBotScopes(REQUIRED_SLACK_BOT_SCOPES), []);
  assert.deepEqual(missingSlackBotScopes([...REQUIRED_SLACK_BOT_SCOPES, 'channels:read']), []);
  assert.deepEqual(
    missingSlackBotScopes(REQUIRED_SLACK_BOT_SCOPES.filter((scope) => scope !== 'users:read')),
    ['users:read'],
  );
});

test('remediation names the missing scopes and the manifest action', () => {
  const remediation = slackManifestRemediation(['users:read', 'files:read']);
  assert.match(remediation, /users:read, files:read/);
  assert.match(remediation, /sky slack manifest/);
  assert.match(remediation, /reinstall/i);
  assert.match(slackManifestRemediation(), /sky slack manifest/);
  assert.doesNotMatch(slackManifestRemediation(), /Missing Slack bot scopes/);
});

test('sky slack manifest --json emits the manifest and the create link', async () => {
  const result = await runCli(['slack', 'manifest', '--json']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.manifest, buildSlackAppManifest());
  assert.equal(payload.createUrl, slackAppCreateUrl());
  assert.equal(payload.consoleUrl, 'https://api.slack.com/apps');
});

test('sky slack manifest prints the link, the manifest, and the update path', async () => {
  const result = await runCli(['slack', 'manifest']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes(slackAppCreateUrl()));
  assert.ok(result.stdout.includes('"agent_view"'));
  assert.match(result.stdout, /App Manifest/);
  assert.match(result.stdout, /reinstall/i);
  // Non-TTY runs must stay quiet about browsers and never launch one.
  assert.doesNotMatch(result.stdout, /Opened the create-from-manifest link/);
});
