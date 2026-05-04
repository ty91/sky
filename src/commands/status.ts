import { Command } from 'commander';
import { isRunning, LOG_FILE, readPid, removePidFile } from '../daemon.js';
import { readHealthSnapshot } from '../runtime/health-store.js';
import { loadSettings, type Settings } from '../settings.js';

function tryLoadSettings(): Settings | undefined {
  try {
    return loadSettings({ silent: true });
  } catch {
    return undefined;
  }
}

function printHealth(): void {
  const health = readHealthSnapshot();
  if (!health) {
    console.log('telegram health: unavailable');
    return;
  }

  console.log(`lifecycle: ${health.state}`);
  console.log(`telegram phase: ${health.telegramPhase}`);
  console.log(`telegram network: ${health.telegramNetwork} fixed`);
  console.log(`ready: ${health.ready ? 'yes' : 'no'}`);
  if (health.botUsername) {
    console.log(`telegram: @${health.botUsername}`);
  }
  console.log(`attempt: ${health.currentAttempt}`);
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
  if (health.lastProbe) {
    console.log(
      `last probe: ok=${health.lastProbe.ok ? 'yes' : 'no'} duration=${health.lastProbe.durationMs}ms remote=${health.lastProbe.remoteAddress ?? 'n/a'} family=${health.lastProbe.remoteFamily ?? 'n/a'} network=ipv4`,
    );
    if (health.lastProbe.errorCode || health.lastProbe.errorMessage) {
      console.log(
        `last probe error: [${health.lastProbe.errorCode ?? 'unknown'}] ${health.lastProbe.errorMessage ?? '(no message)'}`,
      );
    }
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
    const settings = tryLoadSettings();
    const pid = readPid();
    if (isRunning(pid)) {
      console.log(`sky is running (pid: ${pid})`);
      console.log(`log: ${LOG_FILE}`);
      if (settings?.slack) {
        console.log('slack app: configured');
      }
      if (settings?.telegram) {
        printHealth();
      } else {
        console.log('telegram runtime: disabled');
      }
      return;
    }

    if (pid) {
      removePidFile();
    }

    console.log('sky is stopped');
    console.log(`log: ${LOG_FILE}`);
    if (settings?.slack) {
      console.log('slack app: configured');
    }
    if (settings?.telegram) {
      printHealth();
    } else if (settings) {
      console.log('telegram runtime: disabled');
    }
  });
