import { Command, InvalidArgumentError } from 'commander';
import { PRODUCT_VERSION } from './product-version.js';
import type { AdminAssetReader } from './skyd/admin-http.js';

export type SkydCliDependencies = {
  adminAssets?: AdminAssetReader;
};

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const handlers = new Map<NodeJS.Signals, () => void>();
    const cleanup = () => {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
    };

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = () => {
        cleanup();
        resolve();
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
  });
}

function parseAdminPort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new InvalidArgumentError('Admin port must be an integer between 0 and 65535.');
  }
  return port;
}

async function runForeground(
  supervised: boolean,
  adminPort: number | undefined,
  dependencies: SkydCliDependencies,
): Promise<void> {
  const { startSkyd } = await import('./skyd/app.js');
  const daemon = await startSkyd({
    supervisionMode: supervised ? 'launchd' : 'foreground',
    admin: {
      ...(dependencies.adminAssets === undefined ? {} : { assets: dependencies.adminAssets }),
      ...(adminPort === undefined ? {} : { port: adminPort }),
    },
  });
  try {
    await Promise.race([waitForShutdownSignal(), daemon.finished]);
  } finally {
    await daemon.close();
  }
}

export async function runSkyd(
  userArgs: readonly string[],
  dependencies: SkydCliDependencies = {},
): Promise<void> {
  const program = new Command()
    .name('skyd')
    .description('Sky foreground daemon')
    .version(PRODUCT_VERSION)
    .option('--foreground', 'Run the daemon in the foreground')
    .option('--supervised', 'Run under the installed process supervisor')
    .option('--admin-port <port>', 'Bind the admin gateway to a specific port', parseAdminPort)
    .action(async (options: { foreground?: boolean; supervised?: boolean; adminPort?: number }) => {
      if (!options.foreground) {
        program.error('skyd must be run explicitly with --foreground');
      }
      await runForeground(options.supervised === true, options.adminPort, dependencies);
    });

  await program.parseAsync(userArgs, { from: 'user' });
}
