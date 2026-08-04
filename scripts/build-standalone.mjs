import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const standaloneRoot = path.join(repositoryRoot, 'dist', 'standalone');
const artifactDirectory = path.join(standaloneRoot, 'darwin-arm64');
const skyExecutable = path.join(artifactDirectory, 'sky');
const skydExecutable = path.join(artifactDirectory, 'skyd');
const metafilePath = path.join(standaloneRoot, 'darwin-arm64.metafile.json');

const nodeSqliteCompatibilityPlugin = {
  name: 'node-sqlite-compatibility',
  setup(build) {
    build.onResolve({ filter: /^node:sqlite$/ }, () => ({
      path: 'node:sqlite',
      namespace: 'node-sqlite-compatibility',
    }));
    build.onLoad(
      { filter: /.*/, namespace: 'node-sqlite-compatibility' },
      () => ({
        // Bun 1.3.14 does not expose Node 24's module name, but Sky only uses
        // the synchronous API shared by Bun's native SQLite implementation.
        contents: "export { Database as DatabaseSync } from 'bun:sqlite';",
        loader: 'js',
      }),
    );
  },
};

function run(executable, args) {
  return execFileSync(executable, args, {
    cwd: artifactDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function verifyToolchain() {
  const mise = await readFile(path.join(repositoryRoot, 'mise.toml'), 'utf8');
  const pinnedVersion = mise.match(/^bun\s*=\s*"([^"]+)"$/m)?.[1];
  assert.ok(pinnedVersion, 'mise.toml must pin a Bun version');
  assert.equal(
    Bun.version,
    pinnedVersion,
    `standalone build requires Bun ${pinnedVersion}, got ${Bun.version}`,
  );
  assert.equal(process.platform, 'darwin', 'standalone verification requires macOS');
  assert.equal(process.arch, 'arm64', 'standalone verification requires Apple Silicon');
}

async function verifyArtifact(version) {
  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  assert.deepEqual(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name).toSorted(),
    ['sky'],
    'artifact must contain exactly one physical file',
  );
  assert.deepEqual(
    entries.filter((entry) => entry.isSymbolicLink()).map((entry) => entry.name).toSorted(),
    ['skyd'],
    'artifact must contain only the skyd symlink in addition to sky',
  );
  assert.equal(entries.length, 2, 'artifact must not contain unexpected entries');

  const skyStat = await lstat(skyExecutable);
  assert.equal(skyStat.mode & 0o777, 0o755, 'sky must have executable mode 0755');
  assert.equal(await readlink(skydExecutable), 'sky', 'skyd must point to sky by relative path');

  const fileDescription = run('/usr/bin/file', ['-b', skyExecutable]).trim();
  assert.match(fileDescription, /^Mach-O 64-bit executable arm64\b/);
  assert.equal(run('/usr/bin/lipo', ['-archs', skyExecutable]).trim(), 'arm64');

  assert.equal(run(skyExecutable, ['--version']).trim(), version);
  assert.match(run(skyExecutable, ['--help']), /^Usage: sky \[options\] \[command\]/m);
  assert.equal(run(skydExecutable, ['--version']).trim(), version);
  assert.match(run(skydExecutable, ['--help']), /^Usage: skyd \[options\]/m);
}

async function main() {
  await verifyToolchain();

  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );

  await rm(standaloneRoot, { recursive: true, force: true });
  await mkdir(artifactDirectory, { recursive: true });

  const build = await Bun.build({
    entrypoints: [path.join(repositoryRoot, 'src', 'standalone.ts')],
    compile: {
      target: 'bun-darwin-arm64',
      outfile: skyExecutable,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    define: {
      SKY_BUILD_VERSION: JSON.stringify(manifest.version),
    },
    metafile: true,
    plugins: [nodeSqliteCompatibilityPlugin],
  });

  assert.equal(build.success, true, 'Bun standalone build failed');
  assert.equal(build.outputs.length, 1, 'Bun build must emit exactly one executable');
  assert.ok(build.metafile, 'Bun build must return a metafile');
  await writeFile(metafilePath, `${JSON.stringify(build.metafile, null, 2)}\n`);
  await symlink('sky', skydExecutable);

  await verifyArtifact(manifest.version);
  console.log(`Built and verified ${path.relative(repositoryRoot, artifactDirectory)}.`);
  console.log(`Metafile: ${path.relative(repositoryRoot, metafilePath)}`);
}

await main();
