import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = path.join(root, 'apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sky.app');

function status(socketPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ socketPath, path: '/status', timeout: 1000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => {
        try {
          assert.equal(response.statusCode, 200, body);
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('control request timed out')));
    request.on('error', reject);
  });
}

async function waitForHost(child, socketPath, stderr) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, stderr());
    assert.equal(child.signalCode, null, stderr());
    try {
      const document = await status(socketPath);
      if (document.admin.state === 'listening') return document;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`bundled host did not start: ${lastError}\n${stderr()}`);
}

test('relocated Sky.app runs its host and embedded admin without Node.js or Bun', { timeout: 60_000 }, async () => {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  const temporary = await mkdtemp('/tmp/sky-app-');
  let child;
  try {
    const installed = path.join(temporary, 'Applications With Spaces/Sky.app');
    await cp(bundle, installed, { recursive: true });
    const contents = path.join(installed, 'Contents');
    const bin = path.join(contents, 'MacOS');
    const skyd = path.join(bin, 'skyd');
    const skyHome = path.join(temporary, 'sky-home');
    const home = path.join(temporary, 'home');
    const tmp = path.join(temporary, 'tmp');
    await mkdir(home);
    await mkdir(tmp);
    const env = {
      HOME: home,
      SKY_HOME: skyHome,
      PATH: '/usr/bin:/bin',
      TMPDIR: tmp,
      CLAUDE_CODE_TMPDIR: tmp,
      XDG_CACHE_HOME: path.join(temporary, 'cache'),
      XDG_CONFIG_HOME: path.join(temporary, 'config'),
      XDG_DATA_HOME: path.join(temporary, 'data'),
    };
    const run = (executable, args) => execFileSync(executable, args, {
      cwd: temporary, env, encoding: 'utf8', timeout: 10_000,
    }).trim();
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const info = JSON.parse(await readFile(path.join(contents, 'Resources/build-info.json'), 'utf8'));
    const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(contents, 'Info.plist')]));
    assert.equal(plist.CFBundleIdentifier, 'com.jakdo.sky');
    assert.equal(plist.CFBundleExecutable, 'sky-desktop');
    assert.equal(plist.CFBundleShortVersionString, manifest.version);
    assert.equal(plist.LSMinimumSystemVersion, '13.0');
    assert.equal(info.version, manifest.version);
    assert.equal(info.target, 'aarch64-apple-darwin');
    assert.match(info.revision, /^[a-f0-9]{12}(?:-dirty)?$/);
    for (const name of ['sky-desktop', 'skyd']) {
      assert.equal(run('/usr/bin/lipo', ['-archs', path.join(bin, name)]), 'arm64');
      assert.match(run('/usr/bin/otool', ['-l', path.join(bin, name)]), /\bminos 13\.0\b/);
    }
    assert.equal(run(skyd, ['--version']), manifest.version);
    assert.match(run(skyd, ['--help']), /^Usage: skyd /m);
    const sky = path.join(temporary, 'sky');
    await symlink(skyd, sky);
    assert.match(run(sky, ['--help']), /^Usage: sky /m);
    assert.equal(run(sky, ['--version']), manifest.version);
    assert.deepEqual(await readdir(tmp), []);

    child = spawn(skyd, ['--foreground', '--admin-port', '0'], {
      cwd: temporary, env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const document = await waitForHost(child, path.join(skyHome, 'run/skyd.sock'), () => stderr);
    assert.equal(document.productVersion, manifest.version);
    assert.equal(document.runtime.kind, 'standalone');
    assert.equal(document.runtime.state, 'needs_configuration');
    assert.equal(document.supervision.mode, 'foreground');
    const origin = `http://127.0.0.1:${document.admin.port}`;
    const response = await fetch(origin);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Sky Admin/);
    for (const extension of ['js', 'css']) {
      const asset = html.match(new RegExp(`(?:src|href)="(/assets/[^"]+\\.${extension})"`))?.[1];
      assert.ok(asset, html);
      const resource = await fetch(`${origin}${asset}`);
      assert.equal(resource.status, 200, asset);
      assert.ok((await resource.text()).length > 0);
    }
    assert.equal((await readdir(skyHome)).includes('sky.db'), true);
    assert.deepEqual(await readdir(home), []);
    assert.equal(child.exitCode, null, stderr);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.kill('SIGTERM');
      try {
        const [code, signal] = await exit;
        assert.equal(code, 0, `host shutdown signal: ${signal}`);
      } finally {
        clearTimeout(timeout);
        await rm(temporary, { recursive: true, force: true });
      }
    } else {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
