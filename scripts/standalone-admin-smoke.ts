import { createEmbeddedAdminAssetReader } from '../src/skyd/admin-http.js';
import { startSkyd } from '../src/skyd/app.js';
import { EMBEDDED_ADMIN_ASSET_PATHS } from '../src/standalone-admin-manifest.js';

if (
  EMBEDDED_ADMIN_ASSET_PATHS.size === 0 ||
  [...EMBEDDED_ADMIN_ASSET_PATHS.values()].some((assetPath) => !assetPath.includes('$bunfs/'))
) {
  throw new Error('Standalone admin assets must resolve inside bunfs.');
}

const daemon = await startSkyd({
  admin: {
    host: '127.0.0.1',
    port: 0,
    assets: createEmbeddedAdminAssetReader(EMBEDDED_ADMIN_ASSET_PATHS),
  },
});

console.log(`ADMIN_ORIGIN=http://127.0.0.1:${daemon.status().admin.port}`);

await new Promise<void>((resolve) => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});
await daemon.close();
