#!/usr/bin/env node
// Renders packaging/homebrew/sky.rb.tmpl into a concrete formula for the
// ty91/homebrew-tap repository. The release workflow runs this after uploading
// the packed tarball as a GitHub Release asset.
//
// Usage: node scripts/render-homebrew-formula.mjs --sha256 <hex> [--version <v>] [--out <path>]
import { readFileSync, writeFileSync } from 'node:fs';

const TEMPLATE = new URL('../packaging/homebrew/sky.rb.tmpl', import.meta.url);
const MANIFEST = new URL('../package.json', import.meta.url);

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const { version: manifestVersion, name: packageName } = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const version = argument('version') ?? manifestVersion;
const sha256 = argument('sha256');

if (!sha256) {
  console.error('--sha256 <hex> is required.');
  process.exit(1);
}
if (!/^[0-9a-f]{64}$/.test(sha256)) {
  console.error(`--sha256 must be 64 lowercase hex characters, got ${sha256}.`);
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`--version must look like a release version, got ${version}.`);
  process.exit(1);
}

// pnpm pack names the tarball after the package, with the scope separator
// replaced by a dash. Keep this in sync with the release workflow upload step.
const tarball = `${packageName.replace('@', '').replace('/', '-')}-${version}.tgz`;
const url = `https://github.com/ty91/sky/releases/download/v${version}/${tarball}`;

const formula = readFileSync(TEMPLATE, 'utf8')
  .replaceAll('__URL__', url)
  .replaceAll('__SHA256__', sha256)
  .replaceAll('__VERSION__', version);

const leftover = formula.match(/__[A-Z0-9]+__/);
if (leftover) {
  console.error(`Rendered formula still contains the placeholder ${leftover[0]}.`);
  process.exit(1);
}

const out = argument('out');
if (out) {
  writeFileSync(out, formula, 'utf8');
  console.log(`Wrote ${out} for ${packageName}@${version}.`);
} else {
  process.stdout.write(formula);
}
