#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serializeSlackAppManifest } from '../apps/sky/dist/slack/manifest.js';

const target = fileURLToPath(new URL('../slack-app-manifest.json', import.meta.url));
writeFileSync(target, serializeSlackAppManifest(), 'utf8');
console.log(`Wrote ${target}`);
