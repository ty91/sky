#!/usr/bin/env node
import { runEntrypoint } from './runtime-entrypoint.js';
import { runSkyd } from './skyd-cli.js';

await runEntrypoint(() => runSkyd(process.argv.slice(2)));
