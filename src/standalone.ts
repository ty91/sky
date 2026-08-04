import { runEntrypoint, runSelectedRuntime } from './runtime-entrypoint.js';
import { createEmbeddedAdminAssetReader } from './skyd/admin-http.js';
import { EMBEDDED_ADMIN_ASSET_PATHS } from './standalone-admin-manifest.js';

const adminAssets = createEmbeddedAdminAssetReader(EMBEDDED_ADMIN_ASSET_PATHS);
const firstArgument = process.argv[1];
const userArgs = process.argv.slice(firstArgument?.startsWith('/$bunfs/') ? 2 : 1);

await runEntrypoint(() =>
  runSelectedRuntime(process.argv0, userArgs, { adminAssets }),
);
