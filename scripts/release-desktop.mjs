import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const native = path.join(root, 'apps/desktop/src-tauri');
const identity = 'Developer ID Application: Studio Jakdo (RY355N72WN)';
const team = 'RY355N72WN';
const keychain = process.env.SKY_SIGNING_KEYCHAIN ?? path.join(os.homedir(), 'Library/Keychains/sky-signing.keychain-db');
const profile = process.env.SKY_NOTARY_PROFILE ?? 'sky-notary';
const expectedCode = [
  'Contents/Frameworks/clipboard.darwin-arm64.node',
  'Contents/Helpers/claude',
  'Contents/MacOS/sky-desktop',
  'Contents/MacOS/skyd',
];
const defaultApp = path.join(native, 'target/aarch64-apple-darwin/release/bundle/macos/Sky.app');

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

export async function inventoryCode(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Unexpected symlink in desktop bundle: ${relative}`);
    if (entry.isDirectory()) result.push(...await inventoryCode(directory, relative));
    else if (entry.isFile()) {
      const file = await open(path.join(directory, relative), 'r');
      try {
        const magic = Buffer.alloc(4);
        const { bytesRead } = await file.read(magic, 0, 4, 0);
        if (bytesRead === 4 && ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic.toString('hex'))) result.push(relative);
      } finally { await file.close(); }
    }
  }
  return result.toSorted();
}

export function assertCodeInventory(files) {
  assert.deepEqual(files, expectedCode, 'Unexpected executable code: update the desktop signing policy before distributing');
}

export function assertSignatureDetails(details) {
  assert.match(details, /flags=.*\bruntime\b/, 'Hardened Runtime is required');
  assert.match(details, /^Timestamp=.+$/m, 'Secure timestamp is required');
}

function verifyCode(file, signingTeam, identifier, entitlements) {
  const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${signingTeam}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists${identifier ? ` and identifier "${identifier}"` : ''}`;
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', '-R', requirement, file]);
  const details = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', file], { encoding: 'utf8' });
  assert.equal(details.status, 0, details.stderr);
  assertSignatureDetails(details.stderr);
  if (entitlements) {
    const xml = run('/usr/bin/codesign', ['--display', '--entitlements', ':-', file]);
    const keys = [...xml.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]).toSorted();
    assert.deepEqual(keys, entitlements, `Unexpected entitlements: ${file}`);
    if (entitlements.length > 0) assert.match(xml, /<true\s*\/>/);
  }
}

function sign(file, identifier, entitlements) {
  run('/usr/bin/codesign', ['--force', '--sign', identity, '--keychain', keychain,
    '--options', 'runtime', '--timestamp', '--identifier', identifier,
    ...(entitlements ? ['--entitlements', entitlements] : []), file]);
}

async function verifySignatures(app) {
  assertCodeInventory(await inventoryCode(app));
  verifyCode(path.join(app, 'Contents/Helpers/claude'), 'Q6L2SF6YDW', 'com.anthropic.claude-code');
  verifyCode(path.join(app, 'Contents/Frameworks/clipboard.darwin-arm64.node'), team, 'com.jakdo.sky.clipboard', []);
  verifyCode(path.join(app, 'Contents/MacOS/skyd'), team, 'com.jakdo.sky.skyd', ['com.apple.security.cs.allow-jit']);
  verifyCode(app, team, undefined, []);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
}

async function signApp(app) {
  assertCodeInventory(await inventoryCode(app));
  verifyCode(path.join(app, 'Contents/Helpers/claude'), 'Q6L2SF6YDW', 'com.anthropic.claude-code');
  const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')]));
  assert.match(plist.CFBundleIdentifier, /^com\.jakdo\.sky(?:\.test-[a-z0-9-]+)?$/);
  sign(path.join(app, 'Contents/Frameworks/clipboard.darwin-arm64.node'), 'com.jakdo.sky.clipboard');
  sign(path.join(app, 'Contents/MacOS/skyd'), 'com.jakdo.sky.skyd', path.join(native, 'entitlements-host.plist'));
  sign(app, plist.CFBundleIdentifier);
  await verifySignatures(app);
  console.log(`Signed and verified ${app}`);
}

function notary(action, args) {
  return run('/usr/bin/xcrun', ['notarytool', action, ...args, '--keychain-profile', profile, '--keychain', keychain, '--output-format', 'json']);
}

export function requireAccepted(result) {
  assert.equal(result.status, 'Accepted', `Notarization ${result.id}: ${result.status}; inspect notary-log.json before retrying`);
}

async function notarize(app, output, submissionId) {
  await verifySignatures(app);
  const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')]));
  assert.equal(plist.CFBundleIdentifier, 'com.jakdo.sky');
  await mkdir(output, { recursive: true });
  let id = submissionId;
  if (!id) {
    const upload = path.join(output, 'submission.zip');
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, upload]);
    const submission = JSON.parse(notary('submit', [upload]));
    id = submission.id;
    assert.match(id, /^[a-f0-9-]{36}$/i);
    await writeFile(path.join(output, 'submission.json'), `${JSON.stringify(submission, null, 2)}\n`);
    console.log(`Notarization submitted: ${id}`);
  }
  console.log(`Waiting for notarization ${id}; resume with: node scripts/release-desktop.mjs notarize <app> <output> ${id}`);
  let waitError;
  try { notary('wait', [id, '--timeout', '30m']); } catch (error) { waitError = error; }
  const result = JSON.parse(notary('info', [id]));
  await writeFile(path.join(output, 'notary-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'In Progress') {
    await writeFile(path.join(output, 'notary-log.json'), notary('log', [id]));
  }
  if (waitError && result.status === 'In Progress') throw new Error(`Notarization ${id} is still processing; resume using the request ID.`);
  requireAccepted(result);
  run('/usr/bin/xcrun', ['stapler', 'staple', app]);
  await verifyDistribution(app);
  const archive = path.join(output, `Sky-${plist.CFBundleShortVersionString}-darwin-arm64.zip`);
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, archive]);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`);
  console.log(`Distribution ready: ${archive}`);
}

async function verifyDistribution(app) {
  await verifySignatures(app);
  run('/usr/bin/xcrun', ['stapler', 'validate', app]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  console.log(`Signatures, ticket and Gatekeeper verified: ${app}`);
}

async function main() {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  const [action, appArgument, outputArgument, submissionId] = process.argv.slice(2);
  const app = path.resolve(appArgument ?? defaultApp);
  if (action === 'sign') return signApp(app);
  if (action === 'verify') return verifyDistribution(app);
  if (action === 'notarize') {
    assert.ok(outputArgument, 'Usage: notarize <app> <output> [submission-id]');
    return notarize(app, path.resolve(outputArgument), submissionId);
  }
  assert.equal(action, 'release', 'Usage: release | sign <app> | notarize <app> <output> [submission-id] | verify <app>');
  run('pnpm', ['--filter', '@ty91/sky-desktop', 'tauri', 'build', '--target', 'aarch64-apple-darwin', '--bundles', 'app', '--config', path.join(native, 'tauri.release.conf.json'), '--', '--locked'], { cwd: root, stdio: 'inherit' });
  const output = path.join(root, 'dist/desktop-release', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(output, { recursive: true });
  const stagedApp = path.join(output, 'Sky.app');
  run('/usr/bin/ditto', [defaultApp, stagedApp]);
  await signApp(stagedApp);
  run('node', ['--test', path.join(root, 'test/desktop-bundle.smoke.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, SKY_DESKTOP_APP: stagedApp } });
  await notarize(stagedApp, output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    if (error.stderr) console.error(String(error.stderr));
    process.exitCode = 1;
  });
}
