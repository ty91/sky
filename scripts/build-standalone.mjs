import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const adminDirectory = path.join(repositoryRoot, 'dist', 'admin');
const standaloneRoot = path.join(repositoryRoot, 'dist', 'standalone');
const artifactDirectory = path.join(standaloneRoot, 'darwin-arm64');
const skyExecutable = path.join(artifactDirectory, 'sky');
const skydExecutable = path.join(artifactDirectory, 'skyd');
const metafilePath = path.join(standaloneRoot, 'darwin-arm64.metafile.json');
const adminManifestModule = path.join(repositoryRoot, 'src', 'standalone-admin-manifest.ts');
const adminSmokeEntrypoint = path.join(repositoryRoot, 'scripts', 'standalone-admin-smoke.ts');
const claudeHelperManifestModule = path.join(
  repositoryRoot,
  'src',
  'standalone-claude-helper-manifest.ts',
);
// pnpm keeps the SDK's platform package beside the SDK because it is an optional dependency.
const require = createRequire(import.meta.url);
const claudeAgentSdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
const claudeAgentSdkRequire = createRequire(claudeAgentSdkEntry);
const claudeHelperPath = claudeAgentSdkRequire.resolve(
  '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
);

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

function createAdminAssetPlugin(assets) {
  return {
    name: 'embedded-admin-assets',
    setup(build) {
      build.onLoad({ filter: /standalone-admin-manifest\.ts$/ }, (args) => {
        assert.equal(args.path, adminManifestModule);
        const imports = assets.map(
          ({ filePath }, index) =>
            `import asset${index} from ${JSON.stringify(filePath)} with { type: 'file' };`,
        );
        const entries = assets.map(
          ({ relativePath }, index) => `[${JSON.stringify(relativePath)}, asset${index}]`,
        );
        return {
          contents: [
            ...imports,
            `export const EMBEDDED_ADMIN_ASSET_PATHS = new Map([${entries.join(',')}]);`,
          ].join('\n'),
          loader: 'ts',
        };
      });
    },
  };
}

const claudeHelperAssetPlugin = {
  name: 'embedded-claude-helper',
  setup(build) {
    build.onLoad({ filter: /standalone-claude-helper-manifest\.ts$/ }, (args) => {
      assert.equal(args.path, claudeHelperManifestModule);
      return {
        contents: [
          `import helperPath from ${JSON.stringify(claudeHelperPath)} with { type: 'file' };`,
          'export const EMBEDDED_CLAUDE_CODE_EXECUTABLE = helperPath;',
        ].join('\n'),
        loader: 'ts',
      };
    });
  },
};

function verifyClaudeHelperBuild(metafile) {
  const helperInputs = Object.keys(metafile.inputs).filter(
    (input) =>
      /claude-agent-sdk-(?:darwin|linux|win32)-/.test(input) &&
      (input.endsWith('/claude') || input.endsWith('/claude.exe')),
  );
  assert.deepEqual(
    helperInputs,
    [path.relative(repositoryRoot, claudeHelperPath)],
    'standalone must embed exactly the darwin-arm64 Claude helper',
  );
}

function run(executable, args, env = process.env) {
  return execFileSync(executable, args, {
    cwd: artifactDirectory,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function buildAdmin() {
  execFileSync(
    'pnpm',
    ['exec', 'vite', 'build', '--config', 'admin/vite.config.ts', '--logLevel', 'error'],
    { cwd: repositoryRoot, stdio: 'inherit' },
  );
}

async function listAdminAssets(directory = adminDirectory, prefix = '') {
  const assets = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      assets.push(...(await listAdminAssets(filePath, relativePath)));
    } else if (entry.isFile()) {
      assets.push({ relativePath, filePath });
    }
  }
  return assets.toSorted((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function verifyAdminBuild(assets) {
  const paths = assets.map(({ relativePath }) => relativePath);
  assert.ok(paths.includes('index.html'), 'Vite admin build must emit index.html');
  assert.ok(
    paths.some((assetPath) => /^assets\/index-[\w-]+\.js$/.test(assetPath)),
    'Vite admin build must emit a hashed JavaScript asset',
  );
  assert.ok(
    paths.some((assetPath) => /^assets\/index-[\w-]+\.css$/.test(assetPath)),
    'Vite admin build must emit a hashed CSS asset',
  );
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

  const claudeTempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sky-claude-lazy-'));
  try {
    const env = { ...process.env, CLAUDE_CODE_TMPDIR: claudeTempDirectory };
    assert.equal(run(skyExecutable, ['--version'], env).trim(), version);
    assert.match(run(skyExecutable, ['--help'], env), /^Usage: sky \[options\] \[command\]/m);
    assert.equal(run(skydExecutable, ['--version'], env).trim(), version);
    assert.match(run(skydExecutable, ['--help'], env), /^Usage: skyd \[options\]/m);
    assert.deepEqual(
      await readdir(claudeTempDirectory),
      [],
      'version and help must not extract the embedded Claude helper',
    );
  } finally {
    await rm(claudeTempDirectory, { recursive: true, force: true });
  }
}

async function waitForAdmin(child, stdout, stderr, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`standalone daemon exited before admin startup: ${stderr()}`);
    }
    const origin = stdout().match(/^ADMIN_ORIGIN=(http:\/\/127\.0\.0\.1:\d+)$/m)?.[1];
    if (origin !== undefined) {
      try {
        const response = await fetch(origin);
        if (response.ok) return origin;
      } catch {
        // The smoke process printed its address just before the listener became reachable.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`standalone admin did not start: ${stderr()}`);
}

async function verifyStandaloneAdmin(adminAssets, version) {
  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'sky-standalone-admin-'));
  const smokeExecutable = path.join(isolatedRoot, 'admin-smoke');
  let child;
  try {
    const build = await Bun.build({
      entrypoints: [adminSmokeEntrypoint],
      compile: {
        target: 'bun-darwin-arm64',
        outfile: smokeExecutable,
        autoloadDotenv: false,
        autoloadBunfig: false,
      },
      define: {
        SKY_BUILD_VERSION: JSON.stringify(version),
      },
      plugins: [nodeSqliteCompatibilityPlugin, createAdminAssetPlugin(adminAssets)],
    });
    assert.equal(build.success, true, 'standalone admin smoke build failed');
    assert.equal(build.outputs.length, 1, 'standalone admin smoke must emit one executable');

    child = spawn(smokeExecutable, [], {
      cwd: isolatedRoot,
      env: {
        ...process.env,
        HOME: isolatedRoot,
        PATH: '/usr/bin:/bin',
        XDG_CACHE_HOME: path.join(isolatedRoot, 'cache'),
        XDG_CONFIG_HOME: path.join(isolatedRoot, 'config'),
        XDG_DATA_HOME: path.join(isolatedRoot, 'data'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const origin = await waitForAdmin(child, () => stdout, () => stderr);

    const shell = await fetch(origin);
    const html = await shell.text();
    assert.equal(shell.status, 200, html);
    assert.match(html, /Sky Admin/);
    assert.equal(shell.headers.get('cache-control'), 'no-store');

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

    const fallback = await fetch(`${origin}/connections`);
    assert.equal(fallback.status, 200);
    assert.equal(await fallback.text(), html);

    const missingAsset = await fetch(`${origin}/assets/not-a-real-build-output.js`);
    assert.equal(missingAsset.status, 404);
    assert.deepEqual(await missingAsset.json(), { error: { code: 'not_found' } });

    assert.equal(child.exitCode, null, stderr);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

async function main() {
  await verifyToolchain();

  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );

  buildAdmin();
  const adminAssets = await listAdminAssets();
  verifyAdminBuild(adminAssets);

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
    plugins: [
      nodeSqliteCompatibilityPlugin,
      createAdminAssetPlugin(adminAssets),
      claudeHelperAssetPlugin,
    ],
  });

  assert.equal(build.success, true, 'Bun standalone build failed');
  assert.equal(build.outputs.length, 1, 'Bun build must emit exactly one executable');
  assert.ok(build.metafile, 'Bun build must return a metafile');
  verifyClaudeHelperBuild(build.metafile);
  await writeFile(metafilePath, `${JSON.stringify(build.metafile, null, 2)}\n`);
  await symlink('sky', skydExecutable);

  await verifyArtifact(manifest.version);
  await verifyStandaloneAdmin(adminAssets, manifest.version);
  console.log(`Built and verified ${path.relative(repositoryRoot, artifactDirectory)}.`);
  console.log(`Metafile: ${path.relative(repositoryRoot, metafilePath)}`);
}

await main();
