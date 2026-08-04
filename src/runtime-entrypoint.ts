import path from 'node:path';
import type { AdminAssetReader } from './skyd/admin-http.js';

export type RuntimeRole = 'sky' | 'skyd';

export type RuntimeEntrypointDependencies = {
  adminAssets?: AdminAssetReader;
};

export function selectRuntimeRole(invocationPath: string): RuntimeRole {
  const invocationName = path.basename(invocationPath);
  if (invocationName === 'sky' || invocationName === 'skyd') return invocationName;
  throw new Error('Sky runtime must be invoked as sky or skyd.');
}

export async function runEntrypoint(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function runSelectedRuntime(
  invocationPath: string,
  userArgs: readonly string[],
  dependencies: RuntimeEntrypointDependencies = {},
): Promise<void> {
  const role = selectRuntimeRole(invocationPath);
  if (role === 'sky') {
    const { runSky } = await import('./sky-cli.js');
    await runSky(userArgs);
    return;
  }

  const { runSkyd } = await import('./skyd-cli.js');
  await runSkyd(userArgs, { adminAssets: dependencies.adminAssets });
}
