import assert from 'node:assert/strict';

const CLAUDE_HELPER_PATTERN = /claude-agent-sdk-(?:darwin|linux|win32)-[^/]+\/(?:claude|claude\.exe)$/;
const TARGET_CLAUDE_HELPER_PATTERN = /claude-agent-sdk-darwin-arm64\/claude$/;
const CLIPBOARD_ADDON_PATTERN = /(?:^|\/)clipboard\.[^/]+\.node$/;
const TARGET_CLIPBOARD_ADDON_PATTERN = /(?:^|\/)clipboard\.darwin-arm64\.node$/;

export function auditStandaloneMetafile(metafile) {
  assert.ok(
    metafile !== null &&
      typeof metafile === 'object' &&
      metafile.inputs !== null &&
      typeof metafile.inputs === 'object' &&
      !Array.isArray(metafile.inputs),
    'standalone metafile must contain an inputs object',
  );

  const inputs = Object.keys(metafile.inputs);
  const claudeHelpers = inputs.filter((input) => CLAUDE_HELPER_PATTERN.test(input));
  const nonTargetClaudeHelpers = claudeHelpers.filter(
    (input) => !TARGET_CLAUDE_HELPER_PATTERN.test(input),
  );
  assert.deepEqual(
    nonTargetClaudeHelpers,
    [],
    'standalone must not include a Claude helper for a non-darwin-arm64 target',
  );
  assert.equal(
    claudeHelpers.length,
    1,
    'standalone must include exactly one darwin-arm64 Claude helper',
  );

  const clipboardAddons = inputs.filter((input) => CLIPBOARD_ADDON_PATTERN.test(input));
  const nonTargetClipboardAddons = clipboardAddons.filter(
    (input) => !TARGET_CLIPBOARD_ADDON_PATTERN.test(input),
  );
  assert.deepEqual(
    nonTargetClipboardAddons,
    [],
    'standalone must not include a Pi clipboard addon for a non-darwin-arm64 target',
  );
  assert.equal(
    clipboardAddons.length,
    1,
    'standalone must include exactly one darwin-arm64 Pi clipboard addon',
  );

  return {
    claudeHelper: claudeHelpers[0],
    clipboardAddon: clipboardAddons[0],
  };
}
