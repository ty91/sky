import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startSkyd } from '../dist/skyd/app.js';
import { getDaemonStatus } from '../dist/skyd/control-uds.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const skyEntrypoint = path.join(repositoryRoot, 'dist', 'index.js');

function runCli(args, homeDir, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: homeDir, ...extraEnv };
    delete env.SKY_HOME;
    const child = spawn(process.execPath, [skyEntrypoint, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function exchangeLogin(port, token) {
  const body = JSON.stringify({ token });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/auth/exchange',
        headers: {
          origin: `http://127.0.0.1:${port}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

test('sky admin opens a fragment login locally and --no-open prints remote bootstrap values', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-admin-cli-'));
  const browser = path.join(homeDir, 'capture-browser');
  const capturedUrl = path.join(homeDir, 'browser-url');
  await writeFile(browser, '#!/bin/sh\nprintf \'%s\' "$1" > "$SKY_BROWSER_CAPTURE"\n');
  await chmod(browser, 0o700);
  const daemon = await startSkyd({
    homeDir,
    admin: { host: '127.0.0.1', port: 0 },
  });
  try {
    const port = (await getDaemonStatus(daemon.paths.socketFile)).admin.port;
    const opened = await runCli(['admin'], homeDir, {
      BROWSER: browser,
      SKY_BROWSER_CAPTURE: capturedUrl,
    });
    assert.equal(opened.code, 0, opened.stderr || opened.stdout);
    assert.doesNotMatch(opened.stdout + opened.stderr, /[A-Za-z0-9_-]{43}/);
    const url = new URL(await readFile(capturedUrl, 'utf8'));
    assert.equal(url.origin, `http://127.0.0.1:${port}`);
    const token = new URLSearchParams(url.hash.slice(1)).get('token');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(await exchangeLogin(port, token), 200);

    const manual = await runCli(['admin', '--no-open'], homeDir);
    assert.equal(manual.code, 0, manual.stderr || manual.stdout);
    assert.match(manual.stdout, new RegExp(`Admin URL: http://[^/]+:${port}/`));
    assert.match(manual.stdout, /Login token: [A-Za-z0-9_-]{43}/);
    assert.doesNotMatch(manual.stdout, /#token=/);

    const failedOpen = await runCli(['admin'], homeDir, {
      BROWSER: path.join(homeDir, 'missing-browser'),
    });
    assert.equal(failedOpen.code, 1);
    assert.match(failedOpen.stderr, /Could not open Sky Admin/);
    assert.doesNotMatch(failedOpen.stdout + failedOpen.stderr, /[A-Za-z0-9_-]{43}/);
  } finally {
    await daemon.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
