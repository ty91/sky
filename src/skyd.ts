#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { startSkyd } from './skyd/app.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

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
  const daemon = await startSkyd({ supervisionMode: supervised ? 'launchd' : 'foreground' });
  try {
    await Promise.race([waitForShutdownSignal(), daemon.finished]);
  } finally {
    await daemon.close();
  }
}

const program = new Command()
  .name('skyd')
  .description('Sky foreground daemon')
  .version(version)
  .option('--foreground', 'Run the daemon in the foreground')
  .option('--supervised', 'Run under the installed process supervisor')
  .action(async (options: { foreground?: boolean; supervised?: boolean }) => {
    if (!options.foreground) {
      program.error('skyd must be run explicitly with --foreground');
    }
    await runForeground(options.supervised === true);
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
