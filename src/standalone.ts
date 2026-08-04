import { runEntrypoint, runSelectedRuntime } from './runtime-entrypoint.js';
import { createEmbeddedAdminAssetReader } from './skyd/admin-http.js';
import { EMBEDDED_ADMIN_ASSET_PATHS } from './standalone-admin-manifest.js';

const adminAssets = createEmbeddedAdminAssetReader(EMBEDDED_ADMIN_ASSET_PATHS);

await runEntrypoint(() =>
  runSelectedRuntime(process.argv0, process.argv.slice(1), { adminAssets }),
);
