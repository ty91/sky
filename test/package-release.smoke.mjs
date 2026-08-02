import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('the release package installs globally and exposes the sky and skyd CLIs', { timeout: 180_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sky-package-release-'));
  const packDir = path.join(tempDir, 'pack');
  const pnpmHome = path.join(tempDir, 'pnpm-home');
  const staleOutput = path.join(repositoryRoot, 'dist', 'stale-package-output.js');

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

    for (const [dependency, version] of Object.entries(packedManifest.dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${dependency} must use an exact version`);
    }

    assert.ok(packedPaths.includes('dist/index.js'));
    assert.ok(packedPaths.includes('dist/skyd.js'));
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
    assert.match(run(sky, ['--help'], { env: isolatedEnv }), /Usage: sky/);
    assert.equal((await lstat(skyd)).mode & 0o111, 0o111);
  } finally {
    await rm(staleOutput, { force: true });
    await rm(tempDir, { recursive: true, force: true });
  }
});
