import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const socketFile = path.join(process.env.HOME, '.sky', 'run', 'skyd.sock');
await mkdir(path.dirname(socketFile), { recursive: true, mode: 0o700 });
await rm(socketFile, { force: true });

const startedAt = new Date().toISOString();
const runtimeState = process.env.SKY_FAKE_RUNTIME_STATE ?? 'ready';
const status = {
  instanceId: `fake-${process.pid}`,
  supervision: { mode: 'launchd' },
  process: {
    pid: process.pid,
    state: 'running',
    startedAt,
    uptimeMs: 0,
  },
  runtime: { state: runtimeState },
  productVersion: 'test',
  slack: {
    state: runtimeState === 'needs_configuration' ? 'not_configured' : 'connected',
    attempts: 0,
    nextRetryAt: null,
  },
  agent: {
    backend: 'pi',
    model: 'anthropic/test',
  },
  activeWorkCount: 0,
  recentErrors: [],
};

async function replaceForRestart() {
  await new Promise((resolve) => server.close(resolve));
  await rm(socketFile, { force: true });
  const child = spawn(process.execPath, [process.env.SKY_FAKE_DAEMON], {
    detached: true,
    env: process.env,
    stdio: 'ignore',
  });
  child.unref();
  const state = JSON.parse(await readFile(process.env.SKY_FAKE_LAUNCHCTL_STATE, 'utf8'));
  state.pid = child.pid;
  await writeFile(process.env.SKY_FAKE_LAUNCHCTL_STATE, JSON.stringify(state));
  process.exit(0);
}

const server = http.createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/restart') {
    const body = JSON.stringify({ accepted: true, instanceId: status.instanceId });
    response.writeHead(202, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body, () => void replaceForRestart());
    return;
  }
  if (request.method !== 'GET' || request.url !== '/status') {
    response.writeHead(404).end();
    return;
  }
  const body = JSON.stringify(status);
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(socketFile, resolve);
});
await writeFile(process.env.SKY_FAKE_DAEMON_READY_FILE, `${process.pid}\n`);

const close = async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(socketFile, { force: true });
  process.exit(0);
};

process.once('SIGTERM', close);
process.once('SIGINT', close);
