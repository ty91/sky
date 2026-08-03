import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

async function waitForAdmin(origin, child, stderr, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`packed daemon exited before admin startup (${child.exitCode}): ${stderr()}`);
    }
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // The TCP listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`packed daemon admin did not start: ${stderr()}`);
}

function startPackedDaemon(skyd, env, cwd) {
  const child = spawn(skyd, ['--foreground', '--supervised'], {
    cwd,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return { child, stderr: () => stderr };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

async function adminGrant(sky, env, cwd, daemon) {
  const deadline = Date.now() + 15_000;
  let lastError;
  let output;
  while (Date.now() < deadline) {
    try {
      output = run(sky, ['admin', '--no-open'], { env, cwd });
      break;
    } catch (error) {
      lastError = error;
      if (daemon?.child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (!output) {
    throw new Error(
      `packed sky admin failed; daemon exit=${daemon?.child.exitCode ?? 'running'} stderr=${daemon?.stderr() ?? ''}`,
      { cause: lastError },
    );
  }
  const token = output.match(/^Login token: (.+)$/m)?.[1];
  assert.ok(token, output);
  return token;
}

async function exchangeToken(origin, token) {
  const response = await fetch(`${origin}/api/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ token }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);
  return { cookie, session: JSON.parse(body) };
}

async function api(origin, requestPath, options = {}) {
  const response = await fetch(`${origin}${requestPath}`, {
    ...options,
    headers: {
      accept: 'application/json',
      ...options.headers,
    },
  });
  const body = await response.text();
  return { response, body, json: body ? JSON.parse(body) : null };
}

test('the release package installs globally and completes the admin restart flow', { timeout: 240_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sky-package-release-'));
  const packDir = path.join(tempDir, 'pack');
  const pnpmHome = path.join(tempDir, 'pnpm-home');
  const staleOutput = path.join(repositoryRoot, 'dist', 'stale-package-output.js');
  let daemon;
  let replacement;

  try {
    await mkdir(packDir, { recursive: true });
    await mkdir(path.dirname(staleOutput), { recursive: true });
    await writeFile(staleOutput, 'throw new Error("stale output was packaged");\n');

    const packResult = JSON.parse(
      run('pnpm', ['pack', '--pack-destination', packDir, '--json'], {
        cwd: repositoryRoot,
      }),
    );
    const tarball = path.isAbsolute(packResult.filename)
      ? packResult.filename
      : path.join(packDir, packResult.filename);
    const packedPaths = packResult.files.map(({ path: packedPath }) => packedPath);
    const packedManifest = JSON.parse(
      run('tar', ['-xOf', tarball, 'package/package.json']),
    );
    const repositoryManifest = JSON.parse(
      await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    );

    assert.equal(packedManifest.name, '@ty91/sky');
    assert.equal(packedManifest.version, repositoryManifest.version);
    assert.equal(packedManifest.private, undefined);
    assert.deepEqual(packedManifest.bin, { sky: 'dist/index.js', skyd: 'dist/skyd.js' });
    assert.equal(packedManifest.engines.node, '>=24.16.0 <25');
    assert.equal(packedManifest.publishConfig.registry, 'https://npm.pkg.github.com');
    assert.equal(packedManifest.repository.url, 'git+https://github.com/ty91/sky.git');

    // The Homebrew formula pins this exact asset name, and the release workflow
    // uploads whatever pnpm pack produced. Drift here would 404 every brew install.
    const formula = run('node', [
      path.join(repositoryRoot, 'scripts', 'render-homebrew-formula.mjs'),
      '--sha256',
      'd8751ade93f441b1f666c87c4d86154de942d4b6b7946282118537e9154ff8a8',
    ]);
    const formulaUrl = formula.match(/url "([^"]+)"/)?.[1];
    assert.equal(path.basename(formulaUrl ?? ''), path.basename(tarball));

    for (const [dependency, version] of Object.entries(packedManifest.dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${dependency} must use an exact version`);
    }

    assert.ok(packedPaths.includes('dist/index.js'));
    assert.ok(packedPaths.includes('dist/skyd.js'));
    assert.ok(packedPaths.includes('dist/admin/index.html'));
    assert.ok(packedPaths.some((packedPath) => /^dist\/admin\/assets\/index-[\w-]+\.js$/.test(packedPath)));
    assert.ok(packedPaths.some((packedPath) => /^dist\/admin\/assets\/index-[\w-]+\.css$/.test(packedPath)));
    assert.ok(!packedPaths.includes('dist/stale-package-output.js'));
    assert.ok(
      packedPaths.every(
        (packedPath) =>
          packedPath === 'package.json' ||
          packedPath === 'README.md' ||
          packedPath.startsWith('dist/'),
      ),
      `unexpected package files:\n${packedPaths.join('\n')}`,
    );

    const isolatedEnv = {
      ...process.env,
      HOME: tempDir,
      PNPM_HOME: pnpmHome,
      XDG_CACHE_HOME: path.join(tempDir, 'cache'),
      XDG_CONFIG_HOME: path.join(tempDir, 'config'),
      XDG_DATA_HOME: path.join(tempDir, 'data'),
      PATH: [path.join(pnpmHome, 'bin'), pnpmHome, process.env.PATH ?? ''].join(path.delimiter),
    };

    run('pnpm', ['add', '--global', tarball], { env: isolatedEnv });

    const globalBinDir = run('pnpm', ['bin', '--global'], { env: isolatedEnv })
      .trim()
      .split('\n')
      .at(-1);
    assert.ok(globalBinDir);
    const sky = path.join(globalBinDir, 'sky');
    const skyd = path.join(globalBinDir, 'skyd');
    assert.equal(run(sky, ['--version'], { env: isolatedEnv }).trim(), repositoryManifest.version);
    const skyHelp = run(sky, ['--help'], { env: isolatedEnv });
    assert.match(skyHelp, /Usage: sky/);
    assert.match(skyHelp, /\badmin\b/);
    assert.match(run(sky, ['admin', '--help'], { env: isolatedEnv }), /--no-open/);
    assert.equal(run(skyd, ['--version'], { env: isolatedEnv }).trim(), repositoryManifest.version);
    assert.match(run(skyd, ['--help'], { env: isolatedEnv }), /Usage: skyd/);
    assert.equal((await lstat(skyd)).mode & 0o111, 0o111);

    const globalPackages = JSON.parse(
      run('pnpm', ['list', '--global', '--json', '--depth', '0'], { env: isolatedEnv }),
    );
    const installedPackageRoot = globalPackages[0]?.dependencies?.['@ty91/sky']?.path;
    assert.ok(installedPackageRoot);
    const installedAdminHtml = await readFile(
      path.join(installedPackageRoot, 'dist', 'admin', 'index.html'),
      'utf8',
    );
    const installedAssetPath = installedAdminHtml.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    assert.ok(installedAssetPath, installedAdminHtml);
    const installedAdminScript = await readFile(
      path.join(installedPackageRoot, 'dist', 'admin', installedAssetPath.replace(/^\//, '')),
      'utf8',
    );
    assert.match(installedAdminScript, /Sign in to Sky/);
    assert.match(installedAdminScript, /Dashboard/);

    const origin = 'http://127.0.0.1:4815';
    daemon = startPackedDaemon(skyd, isolatedEnv, tempDir);
    await waitForAdmin(origin, daemon.child, daemon.stderr);

    const shellResponse = await fetch(`${origin}/system`);
    assert.equal(shellResponse.status, 200);
    assert.match(await shellResponse.text(), /Sky Admin/);

    const firstLogin = await exchangeToken(
      origin,
      await adminGrant(sky, isolatedEnv, tempDir, daemon),
    );
    const firstHeaders = { cookie: firstLogin.cookie };
    const overview = await api(origin, '/api/overview', { headers: firstHeaders });
    assert.equal(overview.response.status, 200, overview.body);
    assert.equal(overview.json.daemon.supervision.mode, 'launchd');
    assert.equal(overview.json.daemon.runtime.state, 'needs_configuration');

    const configuration = await api(origin, '/api/configuration', { headers: firstHeaders });
    assert.equal(configuration.response.status, 200, configuration.body);
    const mutationHeaders = {
      ...firstHeaders,
      origin,
      'content-type': 'application/json',
      'x-sky-csrf-token': firstLogin.session.csrfToken,
    };
    const configured = await api(origin, '/api/configuration', {
      method: 'PATCH',
      headers: mutationHeaders,
      body: JSON.stringify({
        expectedRevision: configuration.json.revision,
        patch: {
          agentBackend: 'pi',
          model: 'anthropic/claude-opus-4-7',
          workspace: path.join(tempDir, '.sky', 'workspace'),
        },
      }),
    });
    assert.equal(configured.response.status, 200, configured.body);

    const secrets = {
      'slack.botToken': 'xoxb-packed-smoke-secret',
      'slack.appToken': 'xapp-packed-smoke-secret',
    };
    for (const [name, value] of Object.entries(secrets)) {
      const saved = await api(origin, `/api/secrets/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: mutationHeaders,
        body: JSON.stringify({ value }),
      });
      assert.equal(saved.response.status, 200, saved.body);
      assert.doesNotMatch(saved.body, new RegExp(value));
    }

    const checked = await api(origin, '/api/connections/check', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ target: 'agent' }),
    });
    assert.equal(checked.response.status, 200, checked.body);
    assert.ok(checked.json.checks.agent);
    assert.doesNotMatch(checked.body, /xoxb-packed-smoke-secret|xapp-packed-smoke-secret/);

    const restart = await api(origin, '/api/restart', {
      method: 'POST',
      headers: mutationHeaders,
    });
    assert.equal(restart.response.status, 202, restart.body);
    assert.equal(restart.json.accepted, true);
    if (daemon.child.exitCode === null && daemon.child.signalCode === null) {
      await once(daemon.child, 'exit');
    }

    replacement = startPackedDaemon(skyd, isolatedEnv, tempDir);
    await waitForAdmin(origin, replacement.child, replacement.stderr);
    const staleSession = await api(origin, '/api/overview', { headers: firstHeaders });
    assert.equal(staleSession.response.status, 401, staleSession.body);

    const secondLogin = await exchangeToken(
      origin,
      await adminGrant(sky, isolatedEnv, tempDir, replacement),
    );
    const reconnected = await api(origin, '/api/overview', {
      headers: { cookie: secondLogin.cookie },
    });
    assert.equal(reconnected.response.status, 200, reconnected.body);
    assert.notEqual(reconnected.json.daemon.instanceId, overview.json.daemon.instanceId);
    assert.doesNotMatch(
      reconnected.body,
      /xoxb-packed-smoke-secret|xapp-packed-smoke-secret/,
    );
  } finally {
    if (daemon) await stopChild(daemon.child);
    if (replacement) await stopChild(replacement.child);
    await rm(staleOutput, { force: true });
    await rm(tempDir, { recursive: true, force: true });
  }
});
