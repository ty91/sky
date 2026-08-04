import { runEntrypoint, runSelectedRuntime } from './runtime-entrypoint.js';

await runEntrypoint(() => runSelectedRuntime(process.argv0, process.argv.slice(1)));
