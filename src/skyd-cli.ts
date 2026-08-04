import { Command } from 'commander';
import { PRODUCT_VERSION } from './product-version.js';

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

async function runForeground(supervised: boolean): Promise<void> {
  const { startSkyd } = await import('./skyd/app.js');
  const daemon = await startSkyd({ supervisionMode: supervised ? 'launchd' : 'foreground' });
  try {
    await Promise.race([waitForShutdownSignal(), daemon.finished]);
  } finally {
    await daemon.close();
  }
}

export async function runSkyd(userArgs: readonly string[]): Promise<void> {
  const program = new Command()
    .name('skyd')
    .description('Sky foreground daemon')
    .version(PRODUCT_VERSION)
    .option('--foreground', 'Run the daemon in the foreground')
    .option('--supervised', 'Run under the installed process supervisor')
    .action(async (options: { foreground?: boolean; supervised?: boolean }) => {
      if (!options.foreground) {
        program.error('skyd must be run explicitly with --foreground');
      }
      await runForeground(options.supervised === true);
    });

  await program.parseAsync(userArgs, { from: 'user' });
}
