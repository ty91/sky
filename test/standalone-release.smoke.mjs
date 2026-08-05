import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditStandaloneMetafile } from '../scripts/standalone-artifact-audit.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const standaloneRoot = path.join(repositoryRoot, 'dist', 'standalone');
const artifactDirectory = path.join(standaloneRoot, 'darwin-arm64');
const artifactSky = path.join(artifactDirectory, 'sky');
const artifactSkyd = path.join(artifactDirectory, 'skyd');
const metafilePath = path.join(standaloneRoot, 'darwin-arm64.metafile.json');
const runtimePath = '/usr/bin:/bin';

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  assert.equal(result.error, undefined);
  return result;
}

function runSuccessfully(executable, args, options = {}) {
  const result = run(executable, args, options);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForDaemon(sky, child, env, cwd, stderr, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastOutput = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`standalone daemon exited before startup (${child.exitCode}): ${stderr()}`);
    }

    const status = run(sky, ['status', '--json'], { cwd, env });
    lastOutput = status.stdout;
    try {
      const document = JSON.parse(status.stdout);
      const daemon = document.status?.control?.status;
      if (daemon?.admin?.state === 'listening') return daemon;
    } catch {
      lastOutput = `${status.stdout}\n${status.stderr}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`standalone daemon did not start: ${lastOutput}\n${stderr()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exit = once(child, 'exit');
  let timeout;
  const exited = await Promise.race([
    exit.then(() => true),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), 10_000);
    }),
  ]);
  clearTimeout(timeout);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exit;
  }
}

async function verifyArtifactLayout() {
  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  assert.deepEqual(
    entries.map((entry) => ({
      name: entry.name,
      type: entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
    })).toSorted((left, right) => left.name.localeCompare(right.name)),
    [
      { name: 'sky', type: 'file' },
      { name: 'skyd', type: 'symlink' },
    ],
  );

  const skyStat = await lstat(artifactSky);
  assert.equal(skyStat.isFile(), true);
  assert.equal(skyStat.mode & 0o777, 0o755);
  assert.equal(await readlink(artifactSkyd), 'sky');
  assert.match(
    execFileSync('/usr/bin/file', ['-b', artifactSky], { encoding: 'utf8' }),
    /^Mach-O 64-bit executable arm64\b/,
  );
  assert.equal(
    execFileSync('/usr/bin/lipo', ['-archs', artifactSky], { encoding: 'utf8' }).trim(),
    'arm64',
  );

  const metafile = JSON.parse(await readFile(metafilePath, 'utf8'));
  const audited = auditStandaloneMetafile(metafile);
  assert.match(audited.claudeHelper, /claude-agent-sdk-darwin-arm64/);
  assert.match(audited.clipboardAddon, /clipboard\.darwin-arm64\.node$/);
}

test('standalone artifact works outside the checkout without Node.js or Bun', { timeout: 60_000 }, async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  await verifyArtifactLayout();

  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'sky-standalone-release-'));
  const binDirectory = path.join(isolatedRoot, 'bin');
  const homeDirectory = path.join(isolatedRoot, 'home');
  const skyHome = path.join(isolatedRoot, 'sky-home');
  const temporaryDirectory = path.join(isolatedRoot, 'tmp');
  const isolatedSky = path.join(binDirectory, 'sky');
  const isolatedSkyd = path.join(binDirectory, 'skyd');
  let child;

  try {
    await Promise.all([
      mkdir(binDirectory),
      mkdir(homeDirectory),
      mkdir(temporaryDirectory),
    ]);
    await Promise.all([
      symlink(artifactSky, isolatedSky),
      symlink(artifactSky, isolatedSkyd),
    ]);

    const binEntries = await readdir(binDirectory, { withFileTypes: true });
    assert.deepEqual(
      binEntries.map((entry) => ({ name: entry.name, symlink: entry.isSymbolicLink() })).toSorted(
        (left, right) => left.name.localeCompare(right.name),
      ),
      [
        { name: 'sky', symlink: true },
        { name: 'skyd', symlink: true },
      ],
    );
    assert.equal(await exists(path.join(isolatedRoot, 'package.json')), false);
    assert.equal(await exists(path.join(isolatedRoot, 'node_modules')), false);
    for (const directory of runtimePath.split(path.delimiter)) {
      assert.equal(await exists(path.join(directory, 'node')), false);
      assert.equal(await exists(path.join(directory, 'bun')), false);
    }

    const env = {
      HOME: homeDirectory,
      SKY_HOME: skyHome,
      PATH: [binDirectory, runtimePath].join(path.delimiter),
      TMPDIR: temporaryDirectory,
      XDG_CACHE_HOME: path.join(isolatedRoot, 'cache'),
      XDG_CONFIG_HOME: path.join(isolatedRoot, 'config'),
      XDG_DATA_HOME: path.join(isolatedRoot, 'data'),
      LANG: process.env.LANG ?? 'en_US.UTF-8',
    };
    const options = { cwd: isolatedRoot, env };

    assert.equal(runSuccessfully(isolatedSky, ['--version'], options).trim(), manifest.version);
    assert.match(runSuccessfully(isolatedSky, ['--help'], options), /^Usage: sky /m);
    assert.equal(runSuccessfully(isolatedSkyd, ['--version'], options).trim(), manifest.version);
    const skydHelp = runSuccessfully(isolatedSkyd, ['--help'], options);
    assert.match(skydHelp, /^Usage: skyd /m);
    assert.match(skydHelp, /--foreground/);

    const implicit = run(isolatedSkyd, [], options);
    assert.equal(implicit.status, 1);
    assert.match(implicit.stderr, /skyd must be run explicitly with --foreground/);

    child = spawn(isolatedSkyd, ['--foreground', '--admin-port', '0'], {
      ...options,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));

    const daemon = await waitForDaemon(
      isolatedSky,
      child,
      env,
      isolatedRoot,
      () => stderr,
    );
    assert.equal(daemon.productVersion, manifest.version);
    assert.equal(daemon.supervision.mode, 'foreground');
    assert.equal(daemon.runtime.kind, 'standalone');
    assert.equal(daemon.runtime.state, 'needs_configuration');
    assert.ok(daemon.admin.port > 0);

    const doctor = run(isolatedSky, ['doctor', '--json'], options);
    assert.equal(doctor.status, 1, doctor.stderr || doctor.stdout);
    const report = JSON.parse(doctor.stdout);
    const runtime = report.checks.find(({ id }) => id === 'installation.runtime');
    assert.equal(runtime?.status, 'pass');
    assert.match(runtime?.detail ?? '', /Bun \d+\.\d+\.\d+/);
    assert.match(runtime?.detail ?? '', new RegExp(`build ${manifest.version.replaceAll('.', '\\.')}`));
    assert.equal(report.checks.find(({ id }) => id === 'installation.executable')?.status, 'pass');
    assert.equal(report.checks.some(({ id }) => id === 'installation.node'), false);
    assert.equal(report.checks.some(({ id }) => id === 'installation.wrapper'), false);

    const origin = `http://127.0.0.1:${daemon.admin.port}`;
    const shell = await fetch(origin);
    const html = await shell.text();
    assert.equal(shell.status, 200, html);
    assert.match(html, /Sky Admin/);

    const scriptPath = html.match(/<script[^>]+src="(\/assets\/[^"]+\.js)"/)?.[1];
    const stylePath = html.match(/<link[^>]+href="(\/assets\/[^"]+\.css)"/)?.[1];
    assert.ok(scriptPath, html);
    assert.ok(stylePath, html);

    const script = await fetch(`${origin}${scriptPath}`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /^text\/javascript/);
    assert.equal(script.headers.get('cache-control'), 'public, max-age=31536000, immutable');

    const style = await fetch(`${origin}${stylePath}`);
    assert.equal(style.status, 200);
    assert.match(style.headers.get('content-type') ?? '', /^text\/css/);
    assert.equal(style.headers.get('cache-control'), 'public, max-age=31536000, immutable');

    assert.equal(await exists(skyHome), true);
    assert.equal(await exists(path.join(homeDirectory, '.sky')), false);
    assert.equal(child.exitCode, null, stderr);
  } finally {
    if (child) await stopChild(child);
    await rm(isolatedRoot, { recursive: true, force: true });
  }
});
