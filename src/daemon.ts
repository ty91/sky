import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CLAUDECLAW_DIR } from './settings.js';

const PID_FILE = path.join(CLAUDECLAW_DIR, 'claudeclaw.pid');
export const LOG_FILE = path.join(CLAUDECLAW_DIR, 'claudeclaw.log');

function ensureDir() {
  mkdirSync(CLAUDECLAW_DIR, { recursive: true });
}

export function readPid(): number | null {
  try {
    const raw = readFileSync(PID_FILE, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function isRunning(pid: number | null): pid is number {
  if (!pid) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function removePidFile() {
  rmSync(PID_FILE, { force: true });
}

export function startDaemon() {
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
  const botEntry = fileURLToPath(new URL('./bot.js', import.meta.url));
  const child = spawn(process.execPath, [botEntry], {
    detached: true,
    stdio: ['ignore', out, err],
    env: process.env,
  });

  child.unref();
  writeFileSync(PID_FILE, `${child.pid}\n`);

  console.log(`claudeclaw started (pid: ${child.pid})`);
  console.log(`log: ${LOG_FILE}`);
}

export async function stopDaemon() {
  const pid = readPid();
  if (!isRunning(pid)) {
    if (pid) removePidFile();
    console.log('claudeclaw is already stopped');
    return;
  }

  process.kill(pid, 'SIGTERM');

  const deadline = Date.now() + 30000;
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
