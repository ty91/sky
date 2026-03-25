#!/usr/bin/env node
import 'dotenv/config';
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { startBot } from './bot.js';

const CLAUDECLAW_DIR = path.join(os.homedir(), '.claudeclaw');
const PID_FILE = path.join(CLAUDECLAW_DIR, 'claudeclaw.pid');
const LOG_FILE = path.join(CLAUDECLAW_DIR, 'claudeclaw.log');

function ensureDir() {
  mkdirSync(CLAUDECLAW_DIR, { recursive: true });
}

function readPid(): number | null {
  try {
    const raw = readFileSync(PID_FILE, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(pid: number | null): pid is number {
  if (!pid) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removePidFile() {
  rmSync(PID_FILE, { force: true });
}

function printStatus() {
  const pid = readPid();
  if (isRunning(pid)) {
    console.log(`claudeclaw is running (pid: ${pid})`);
    console.log(`log: ${LOG_FILE}`);
    return;
  }

  if (pid) {
    removePidFile();
  }

  console.log('claudeclaw is stopped');
}

function startDaemon() {
  ensureDir();

  const pid = readPid();
  if (isRunning(pid)) {
    console.log(`claudeclaw is already running (pid: ${pid})`);
    console.log(`log: ${LOG_FILE}`);
    return;
  }

  if (pid) {
    removePidFile();
  }

  const out = openSync(LOG_FILE, 'a');
  const err = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [path.join(path.dirname(process.argv[1]!), 'bot.js')], {
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--dns-result-order=ipv4first'].filter(Boolean).join(' '),
    },
  });

  child.unref();
  writeFileSync(PID_FILE, `${child.pid}\n`);

  console.log(`claudeclaw started (pid: ${child.pid})`);
  console.log(`log: ${LOG_FILE}`);
}

async function stopDaemon() {
  const pid = readPid();
  if (!isRunning(pid)) {
    if (pid) removePidFile();
    console.log('claudeclaw is already stopped');
    return;
  }

  process.kill(pid, 'SIGTERM');

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) {
      removePidFile();
      console.log('claudeclaw stopped');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  process.kill(pid, 'SIGKILL');
  removePidFile();
  console.log('claudeclaw force-stopped');
}

async function restartDaemon() {
  await stopDaemon();
  startDaemon();
}

function printHelp() {
  console.log(`claudeclaw <command>

Commands:
  start    Start claudeclaw as a daemon
  stop     Stop the daemon
  restart  Restart the daemon
  status   Show daemon status
  run      Run in foreground
  help     Show this help
`);
}

async function main() {
  const command = process.argv[2] ?? 'help';

  switch (command) {
    case 'start':
      startDaemon();
      break;
    case 'stop':
      await stopDaemon();
      break;
    case 'restart':
      await restartDaemon();
      break;
    case 'status':
      printStatus();
      break;
    case 'run':
      await startBot();
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
