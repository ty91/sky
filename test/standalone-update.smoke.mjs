import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const standaloneSky = path.join(repositoryRoot, 'dist', 'standalone', 'darwin-arm64', 'sky');
const nodeSky = path.join(repositoryRoot, 'dist', 'index.js');
const fakeLaunchctl = path.join(repositoryRoot, 'test', 'helpers', 'fake-launchctl.mjs');
const fakeSkyd = path.join(repositoryRoot, 'test', 'helpers', 'fake-skyd.mjs');
const currentVersion = JSON.parse(
  await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
).version;

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sky-standalone-update-'));
  const homeDir = path.join(root, 'home');
  const binDir = path.join(root, 'bin');
  const releaseDir = path.join(root, 'release');
  const stateFile = path.join(root, 'launchctl-state.json');
  const readyFile = path.join(root, 'fake-skyd-ready');
  const sky = path.join(binDir, 'sky');
  await Promise.all([
    mkdir(homeDir),
    mkdir(binDir),
    mkdir(releaseDir),
  ]);
  await copyFile(standaloneSky, sky);
  await chmod(sky, 0o755);
  await symlink('sky', path.join(binDir, 'skyd'));
  await writeFile(
    path.join(binDir, 'launchctl'),
    '#!/bin/sh\nexec "$SKY_TEST_NODE" "$SKY_TEST_FAKE_LAUNCHCTL" "$@"\n',
  );
  await chmod(path.join(binDir, 'launchctl'), 0o755);

  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: [binDir, process.env.PATH ?? ''].join(path.delimiter),
    SKY_TEST_NODE: process.execPath,
    SKY_TEST_FAKE_LAUNCHCTL: fakeLaunchctl,
    SKY_FAKE_LAUNCHCTL_STATE: stateFile,
    SKY_FAKE_DAEMON: fakeSkyd,
    SKY_FAKE_DAEMON_READY_FILE: readyFile,
  };
  return { root, homeDir, binDir, releaseDir, stateFile, sky, env };
}

async function run(executable, args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      encoding: 'utf8',
      env,
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

async function readState(stateFile) {
  return JSON.parse(await readFile(stateFile, 'utf8'));
}

async function cleanup(context) {
  try {
    const state = await readState(context.stateFile);
    if (state.pid) process.kill(state.pid, 'SIGTERM');
  } catch {}
  await rm(context.root, { recursive: true, force: true });
}

async function installService(context) {
  const result = await run(context.sky, ['service', 'install', '--json'], context.env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return readState(context.stateFile);
}

async function createRelease(context, version, options = {}) {
  const artifactDir = path.join(context.root, `artifact-${version}`);
  const archiveName = `sky-${version}-darwin-arm64.tar.gz`;
  const checksumName = `${archiveName}.sha256`;
  const archivePath = path.join(context.releaseDir, archiveName);
  await mkdir(artifactDir);
  await writeFile(
    path.join(artifactDir, 'sky'),
    `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
  );
  await chmod(path.join(artifactDir, 'sky'), 0o755);
  execFileSync('/usr/bin/tar', ['-czf', archivePath, '-C', artifactDir, 'sky']);
  const archive = await readFile(archivePath);
  const digest = createHash('sha256').update(archive).digest('hex');
  const checksum = options.badChecksum
    ? `${'0'.repeat(64)}  ${archiveName}\n`
    : `${digest}  ${archiveName}\n`;
  return { archiveName, checksumName, archive, checksum };
}

async function startReleaseServer(version, release, options = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/latest') {
      const assets = release
        ? [
            {
              name: release.archiveName,
              browser_download_url: `${origin()}/${release.archiveName}`,
            },
            {
              name: release.checksumName,
              browser_download_url: `${origin()}/${release.checksumName}`,
            },
          ]
        : [];
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ tag_name: `v${version}`, assets }));
      return;
    }
    if (release && request.url === `/${release.archiveName}`) {
      if (options.archiveFailure) {
        response.writeHead(503).end('unavailable');
      } else {
        response.end(release.archive);
      }
      return;
    }
    if (release && request.url === `/${release.checksumName}`) {
      response.end(release.checksum);
      return;
    }
    response.writeHead(404).end('not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = () => `http://127.0.0.1:${address.port}`;
  return {
    apiUrl: `${origin()}/latest`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('node runtime refuses self-update before contacting the release server', async () => {
  const result = await run(
    process.execPath,
    [nodeSky, 'update', '--release-api-url', 'http://127.0.0.1:1/latest'],
    process.env,
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /standalone installation/i);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|fetch failed/i);
});

test('standalone update leaves the binary and daemon unchanged when already current', { timeout: 60_000 }, async () => {
  const context = await setup();
  const server = await startReleaseServer(currentVersion);
  try {
    const beforeState = await installService(context);
    const beforeBytes = await readFile(context.sky);
    const result = await run(
      context.sky,
      ['update', '--release-api-url', server.apiUrl],
      context.env,
    );
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /already up to date/i);
    assert.deepEqual(await readFile(context.sky), beforeBytes);
    assert.equal((await readState(context.stateFile)).pid, beforeState.pid);
    assert.deepEqual(server.requests, ['/latest']);
  } finally {
    await server.close();
    await cleanup(context);
  }
});

for (const failure of ['download', 'checksum']) {
  test(`standalone update preserves the binary and daemon after ${failure} failure`, { timeout: 60_000 }, async () => {
    const context = await setup();
    const version = '9.8.7-test.2';
    const release = await createRelease(context, version, {
      badChecksum: failure === 'checksum',
    });
    const server = await startReleaseServer(version, release, {
      archiveFailure: failure === 'download',
    });
    try {
      const beforeState = await installService(context);
      const beforeBytes = await readFile(context.sky);
      const result = await run(
        context.sky,
        ['update', '--release-api-url', server.apiUrl],
        context.env,
      );
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stderr, new RegExp(failure, 'i'));
      assert.deepEqual(await readFile(context.sky), beforeBytes);
      assert.equal((await readState(context.stateFile)).pid, beforeState.pid);
    } finally {
      await server.close();
      await cleanup(context);
    }
  });
}

test('standalone update atomically replaces sky and restarts the daemon', { timeout: 60_000 }, async () => {
  const context = await setup();
  const version = '9.8.7-test.2';
  const release = await createRelease(context, version);
  const server = await startReleaseServer(version, release);
  try {
    const beforeState = await installService(context);
    const result = await run(
      context.sky,
      ['update', '--release-api-url', server.apiUrl],
      context.env,
    );
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(`Updated Sky from ${currentVersion} to ${version}`));
    assert.equal(execFileSync(context.sky, ['--version'], { encoding: 'utf8' }).trim(), version);
    assert.notEqual((await readState(context.stateFile)).pid, beforeState.pid);
  } finally {
    await server.close();
    await cleanup(context);
  }
});
