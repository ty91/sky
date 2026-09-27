import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertCodeInventory, assertSignatureDetails, inventoryCode, requireAccepted } from '../scripts/release-desktop.mjs';

test('signing inventory rejects omitted, unexpected and symlinked executable code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sky-signing-'));
  try {
    const files = ['Contents/Frameworks/clipboard.darwin-arm64.node', 'Contents/Helpers/claude', 'Contents/MacOS/sky-desktop', 'Contents/MacOS/skyd'];
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), Buffer.from('cffaedfe00000000', 'hex'));
    }
    await writeFile(path.join(root, 'Contents/Info.plist'), '<plist/>');
    assertCodeInventory(await inventoryCode(root));
    await writeFile(path.join(root, 'Contents/Helpers/unreviewed'), Buffer.from('cafebabe00000000', 'hex'));
    const unexpected = await inventoryCode(root);
    assert.throws(() => assertCodeInventory(unexpected), /Unexpected executable code/);
    await rm(path.join(root, 'Contents/Helpers/unreviewed'));
    await rm(path.join(root, 'Contents/MacOS/skyd'));
    const missing = await inventoryCode(root);
    assert.throws(() => assertCodeInventory(missing), /Unexpected executable code/);
    await symlink('/bin/sh', path.join(root, 'Contents/MacOS/skyd'));
    await assert.rejects(inventoryCode(root), /Unexpected symlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('distribution signatures require runtime hardening and a secure timestamp', () => {
  assertSignatureDetails('CodeDirectory flags=0x10000(runtime)\nTimestamp=Sep 27, 2026\n');
  assert.throws(() => assertSignatureDetails('CodeDirectory flags=0x0(none)\nTimestamp=Sep 27, 2026\n'), /Hardened Runtime/);
  assert.throws(() => assertSignatureDetails('CodeDirectory flags=0x10000(runtime)\nSigned Time=Sep 27, 2026\n'), /Secure timestamp/);
});

test('only an accepted notarization can produce a distribution', () => {
  requireAccepted({ id: 'request', status: 'Accepted' });
  for (const status of ['Invalid', 'Rejected', 'In Progress', undefined]) {
    assert.throws(() => requireAccepted({ id: 'request', status }), /inspect notary-log/);
  }
});
