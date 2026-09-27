import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConfiguration } from '../dist/configuration.js';
import { createRuntimeController } from '../dist/runtime/controller.js';
import { createSkyHome, prepareSkyHome } from '../dist/sky-home.js';
import { startControlServer } from '../dist/skyd/control-uds.js';
import { createTccValidation } from '../dist/skyd/tcc-validation.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sky-tcc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = createSkyHome({ rootDir: path.join(root, '.sky') });
  prepareSkyHome(paths);
  const directory = path.join(root, 'sky-tcc-validation');
  await mkdir(directory);
  const configFile = path.join(paths.rootDir, 'tcc-validation.json');
  const enable = () => writeFile(configFile, JSON.stringify({ fixtureDirectories: [directory] }), { mode: 0o600 });
  const runtimeController = createRuntimeController({ supervisionMode: 'foreground' });
  const configuration = createConfiguration(paths);
  const create = (createBackend) => createTccValidation({ paths, configuration, runtimeController, createBackend });
  return { paths, directory, configFile, enable, create, runtimeController, configuration };
}

function request(socketPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/validation/tcc', method: 'POST', agent: false }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('TCC validation is opt-in and refuses unsafe configuration files', async (t) => {
  const f = await fixture(t);
  assert.equal(f.create(), undefined);
  await f.enable();
  assert.ok(f.create());
  await chmod(f.configFile, 0o644);
  assert.throws(() => f.create(), /mode-0600/);
  await rm(f.configFile);
  const other = path.join(f.paths.rootDir, 'other.json');
  await writeFile(other, JSON.stringify({ fixtureDirectories: [f.directory] }), { mode: 0o600 });
  await symlink(other, f.configFile);
  assert.throws(() => f.create());
});

test('local control exposes real host fixture access only when enabled and allowlisted', async (t) => {
  const f = await fixture(t);
  const control = { execute() { throw new Error('Unexpected control command'); } };
  const disabled = await startControlServer(f.paths.socketFile, control);
  assert.equal((await request(f.paths.socketFile, {})).status, 404);
  await disabled.close();
  await f.enable();
  const server = await startControlServer(f.paths.socketFile, control, f.create());
  t.after(() => server.close());
  const input = { route: 'host', operation: 'read', directory: f.directory };
  const missing = await request(f.paths.socketFile, input);
  assert.equal(missing.body.outcome.category, 'missing');
  assert.equal(missing.body.outcome.code, 'ENOENT');
  await writeFile(path.join(f.directory, 'input.txt'), 'fixture-unknown-to-the-request');
  const read = await request(f.paths.socketFile, input);
  assert.equal(read.status, 200);
  assert.equal(read.body.outcome.content, 'fixture-unknown-to-the-request');
  assert.equal(read.body.host.pid, process.pid);
  assert.equal(read.body.attribution, 'unverified');
  const written = await request(f.paths.socketFile, { ...input, operation: 'write' });
  assert.equal(await readFile(written.body.target, 'utf8'), written.body.expectedContent);
  assert.equal((await request(f.paths.socketFile, { ...input, directory: '/tmp/sky-tcc-validation' })).status, 400);
  assert.equal((await request(f.paths.socketFile, { ...input, prompt: 'arbitrary command' })).status, 400);
  await rm(path.join(f.directory, 'input.txt'));
  await symlink(written.body.target, path.join(f.directory, 'input.txt'));
  assert.equal((await request(f.paths.socketFile, input)).body.outcome.status, 'execution-failed');
});

test('model completion is not file access evidence and cancellation prevents overlapping probes', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.enable();
  f.configuration.patch(0, { agentBackend: 'pi', model: 'anthropic/test-model', workspace: f.paths.workspaceDir });
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  let disposed = false;
  let received;
  const validation = f.create(() => Object.assign(async (options) => {
    received = options;
    return {
      sessionId: 'validation-session',
      async prompt() { started(); await finished; },
      async abort() {},
      dispose() { disposed = true; },
    };
  }, { backend: 'pi' }));
  const input = { route: 'file', operation: 'read', directory: f.directory };
  const abort = new AbortController();
  const running = validation.run(input, abort.signal);
  await didStart;
  assert.deepEqual(received.agent.tools, ['Read']);
  await assert.rejects(validation.run(input, new AbortController().signal), { code: 'operation_active' });
  abort.abort();
  const report = await running;
  assert.equal(report.outcome.interrupted, true);
  assert.equal(disposed, true);
  assert.deepEqual(report.evidence, []);
  await assert.rejects(validation.run(input, new AbortController().signal), { code: 'operation_active' });
  finish();
  await finished;
  await new Promise((resolve) => setImmediate(resolve));
  const completed = await validation.run(input, new AbortController().signal);
  assert.equal(completed.outcome.status, 'turn-completed');
  assert.equal(completed.outcome.requiresToolEvidenceReview, true);
  assert.deepEqual(completed.evidence, []);
  assert.equal(completed.attribution, 'unverified');
  assert.equal(f.runtimeController.activeCount(), 0);
});
