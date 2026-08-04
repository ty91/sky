import assert from 'node:assert/strict';
import test from 'node:test';
import { auditStandaloneMetafile } from '../scripts/standalone-artifact-audit.mjs';

const claudeArm64 =
  'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude';
const clipboardArm64 =
  'node_modules/@mariozechner/clipboard-darwin-arm64/clipboard.darwin-arm64.node';

function metafile(...inputs) {
  return { inputs: Object.fromEntries(inputs.map((input) => [input, { bytes: 1 }])) };
}

test('standalone artifact audit accepts one darwin-arm64 helper and addon', () => {
  assert.deepEqual(auditStandaloneMetafile(metafile(claudeArm64, clipboardArm64)), {
    claudeHelper: claudeArm64,
    clipboardAddon: clipboardArm64,
  });
});

test('standalone artifact audit rejects duplicate target helpers and addons', () => {
  assert.throws(
    () =>
      auditStandaloneMetafile(
        metafile(
          claudeArm64,
          `vendor/${claudeArm64}`,
          clipboardArm64,
        ),
      ),
    /exactly one darwin-arm64 Claude helper/,
  );
  assert.throws(
    () =>
      auditStandaloneMetafile(
        metafile(
          claudeArm64,
          clipboardArm64,
          `vendor/${clipboardArm64}`,
        ),
      ),
    /exactly one darwin-arm64 Pi clipboard addon/,
  );
});

test('standalone artifact audit rejects non-target helpers and addons', () => {
  assert.throws(
    () =>
      auditStandaloneMetafile(
        metafile(
          claudeArm64,
          'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
          clipboardArm64,
        ),
      ),
    /Claude helper for a non-darwin-arm64 target/,
  );
  assert.throws(
    () =>
      auditStandaloneMetafile(
        metafile(
          claudeArm64,
          clipboardArm64,
          'node_modules/@mariozechner/clipboard-linux-x64/clipboard.linux-x64.node',
        ),
      ),
    /Pi clipboard addon for a non-darwin-arm64 target/,
  );
});
