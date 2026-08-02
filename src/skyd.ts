#!/usr/bin/env node
import { startSkyd } from './skyd/app.js';

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

async function main(): Promise<void> {
  const daemon = await startSkyd();
  try {
    await Promise.race([waitForShutdownSignal(), daemon.finished]);
  } finally {
    await daemon.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
