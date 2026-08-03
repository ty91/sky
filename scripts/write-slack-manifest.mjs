#!/usr/bin/env node
// Regenerates the checked-in slack-app-manifest.json from its TypeScript
// source. Run `pnpm manifest:sync` after changing scopes, events, or display
// fields in src/slack/manifest.ts; test/slack-manifest.test.mjs fails on drift.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serializeSlackAppManifest } from '../dist/slack/manifest.js';

const target = fileURLToPath(new URL('../slack-app-manifest.json', import.meta.url));
writeFileSync(target, serializeSlackAppManifest(), 'utf8');
console.log(`Wrote ${target}`);
