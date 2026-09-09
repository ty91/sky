#!/usr/bin/env node
import { runEntrypoint } from './runtime-entrypoint.js';
import { runSky } from './sky-cli.js';

await runEntrypoint(() => runSky(process.argv.slice(2)));
