import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const native = path.join(root, 'apps/desktop/src-tauri');
const target = 'aarch64-apple-darwin';
assert.equal(process.platform, 'darwin', 'Sky desktop requires macOS');
assert.equal(process.arch, 'arm64', 'Sky desktop requires Apple Silicon');
if (process.env.TAURI_ENV_TARGET_TRIPLE) {
  assert.equal(process.env.TAURI_ENV_TARGET_TRIPLE, target);
}

execFileSync('pnpm', ['build:standalone', '--desktop'], { cwd: root, stdio: 'inherit' });
const executable = path.join(root, 'dist/desktop-host/Contents/MacOS/skyd');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
assert.equal(version, manifest.version);
const revision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '';
await mkdir(path.join(native, 'binaries'), { recursive: true });
await mkdir(path.join(native, 'resources'), { recursive: true });
await copyFile(executable, path.join(native, `binaries/skyd-${target}`));
await copyFile(path.join(root, 'dist/desktop-host/Contents/Helpers/claude'), path.join(native, 'binaries/claude'));
await copyFile(path.join(root, 'dist/desktop-host/Contents/Frameworks/clipboard.darwin-arm64.node'), path.join(native, 'binaries/clipboard.darwin-arm64.node'));
await writeFile(path.join(native, 'resources/build-info.json'), `${JSON.stringify({
  version,
  target,
  revision: `${revision}${dirty ? '-dirty' : ''}`,
}, null, 2)}\n`);
