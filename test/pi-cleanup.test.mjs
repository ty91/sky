import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package runtime dependencies no longer include ACP app-server adapters', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));

  assert.doesNotMatch(pkg.description, /ACP|app-server/i);
  for (const name of [
    '@agentclientprotocol/claude-agent-acp',
    '@agentclientprotocol/codex-acp',
    '@agentclientprotocol/sdk',
  ]) {
    assert.equal(pkg.dependencies?.[name], undefined, `${name} should not be a runtime dependency`);
  }
});

test('README describes Pi operation without ACP or Codex app-server setup', async () => {
  const readme = await readFile('README.md', 'utf8');

  assert.match(readme, /Pi coding agent/);
  assert.doesNotMatch(readme, /ACP|Codex|app-server|codex-home|@agentclientprotocol|CODEX_|OPENAI_API_KEY/i);
});
