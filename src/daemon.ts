import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SKY_DIR } from './settings.js';

const PID_FILE = path.join(SKY_DIR, 'sky.pid');
export const LOG_FILE = path.join(SKY_DIR, 'sky.log');

function ensureDir() {
  mkdirSync(SKY_DIR, { recursive: true });
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

/**
 * Spawn a fresh detached bot process and record its pid. The caller is
 * responsible for ensuring no live daemon is already running — this helper
 * simply fires the spawn, unrefs it, and returns the new pid.
 *
 * Separated out so `startDaemon()` (external CLI) and `spawnDetachedRestart()`
 * (self-restart from inside the bot) share the exact same launch recipe.
 */
function spawnBotProcess(): number {
  const out = openSync(LOG_FILE, 'a');
  const err = openSync(LOG_FILE, 'a');
  const botEntry = fileURLToPath(new URL('./bot.js', import.meta.url));
  const child = spawn(process.execPath, [botEntry], {
    detached: true,
    stdio: ['ignore', out, err],
    env: process.env,
  });

  child.unref();
  if (typeof child.pid === 'number') {
    writeFileSync(PID_FILE, `${child.pid}\n`);
    return child.pid;
  }
  // Node normally always gives us a pid for a detached spawn, but guard anyway.
  return -1;
}

export function startDaemon() {
  ensureDir();

  const pid = readPid();
  if (isRunning(pid)) {
    console.log(`sky is already running (pid: ${pid})`);
    console.log(`log: ${LOG_FILE}`);
    return;
  }

  if (pid) {
    removePidFile();
  }

  const newPid = spawnBotProcess();
  console.log(`sky started (pid: ${newPid})`);
  console.log(`log: ${LOG_FILE}`);
}

/**
 * Called from **inside** the running bot process to swap itself out.
 *
 * Unlike `startDaemon()`, this intentionally skips the "already running"
 * check: the current process *is* the running daemon and is about to exit.
 * Order of operations matters:
 *
 *   1. Delete the stale pid file so the child's first `writeFileSync` to
 *      `PID_FILE` never collides with a concurrent reader.
 *   2. Spawn the detached replacement and unref it.
 *
 * The caller should then initiate its own shutdown (e.g. `process.kill(pid,
 * 'SIGTERM')`). Any brief overlap between the old and new process is tolerated
 * — Slack socket mode accepts multiple concurrent connections, and the old
 * daemon's Slack app stops as soon as the SIGTERM handler resolves.
 */
export function spawnDetachedRestart(): number {
  ensureDir();
  removePidFile();

  const newPid = spawnBotProcess();
  console.log(`[restart] spawned replacement daemon (pid: ${newPid})`);
  return newPid;
}

export async function stopDaemon() {
  const pid = readPid();
  if (!isRunning(pid)) {
    if (pid) removePidFile();
    console.log('sky is already stopped');
    return;
  }

  process.kill(pid, 'SIGTERM');

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) {
      removePidFile();
      console.log('sky stopped');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  process.kill(pid, 'SIGKILL');
  removePidFile();
  console.log('sky force-stopped');
}
