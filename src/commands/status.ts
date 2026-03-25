import { Command } from 'commander';
import { isRunning, LOG_FILE, readPid, removePidFile } from '../daemon.js';
import { readHealthSnapshot } from '../runtime/health-store.js';

function printHealth(): void {
  const health = readHealthSnapshot();
  if (!health) {
    console.log('health: unavailable');
    return;
  }

  console.log(`lifecycle: ${health.state}`);
  console.log(`ready: ${health.ready ? 'yes' : 'no'}`);
  if (health.botUsername) {
    console.log(`telegram: @${health.botUsername}`);
  }
  if (health.lastInitSuccessAt) {
    console.log(`last init success: ${health.lastInitSuccessAt}`);
  }
  if (health.lastPollingStartedAt) {
    console.log(`last polling start: ${health.lastPollingStartedAt}`);
  }
  if (health.lastUpdateReceivedAt) {
    console.log(`last update: ${health.lastUpdateReceivedAt}`);
  }
  if (health.lastOutboundSuccessAt) {
    console.log(`last outbound success: ${health.lastOutboundSuccessAt}`);
  }
  if (health.currentBackoffMs !== undefined) {
    console.log(`backoff: ${health.currentBackoffMs}ms`);
  }
  console.log(`consecutive failures: ${health.consecutiveFailures}`);
  if (health.lastError) {
    console.log(
      `last error: [${health.lastError.phase}/${health.lastError.kind}] ${health.lastError.message}`,
    );
  }
}

export const statusCommand = new Command('status')
  .description('Show daemon status')
  .action(() => {
    const pid = readPid();
    if (isRunning(pid)) {
      console.log(`claudeclaw is running (pid: ${pid})`);
      console.log(`log: ${LOG_FILE}`);
      printHealth();
      return;
    }

    if (pid) {
      removePidFile();
    }

    console.log('claudeclaw is stopped');
    console.log(`log: ${LOG_FILE}`);
    printHealth();
  });
