import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MaintenanceStateError,
  createMaintenanceStateStore,
} from '../dist/skyd/maintenance-state.js';
import { createSkyHome, prepareSkyHome } from '../dist/sky-home.js';

function withFixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sky-maintenance-state-'));
  const home = createSkyHome({ rootDir: path.join(root, 'sky-home') });
  const workspace = path.join(root, 'workspace');
  try {
    prepareSkyHome(home);
    mkdirSync(path.join(workspace, 'memory', 'episodes', 'daily'), { recursive: true });
    return run({ root, home, workspace });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('maintenance state bootstraps the latest completed daily episode once', () => {
  withFixture(({ home, workspace }) => {
    const dailyDirectory = path.join(workspace, 'memory', 'episodes', 'daily');
    writeFileSync(path.join(dailyDirectory, '2026-08-07.md'), 'completed');
    writeFileSync(path.join(dailyDirectory, '2026-08-09.md'), 'not due yet');
    writeFileSync(path.join(dailyDirectory, 'notes.md'), 'not an episode');

    const store = createMaintenanceStateStore(home);
    assert.equal(store.loadOrBootstrap(workspace, '2026-08-08'), '2026-08-07');
    assert.deepEqual(JSON.parse(readFileSync(home.maintenanceStateFile, 'utf8')), {
      schemaVersion: 1,
      dream: { lastSuccessfulTargetDate: '2026-08-07' },
    });
    assert.equal(lstatSync(home.maintenanceStateFile).mode & 0o777, 0o600);

    writeFileSync(path.join(dailyDirectory, '2026-08-08.md'), 'added after bootstrap');
    assert.equal(store.loadOrBootstrap(workspace, '2026-08-08'), '2026-08-07');
  });
});

test('maintenance state atomically advances the successful dream target date', () => {
  withFixture(({ home, workspace }) => {
    const store = createMaintenanceStateStore(home);
    assert.equal(store.loadOrBootstrap(workspace, '2026-08-08'), null);
    const firstInode = statSync(home.maintenanceStateFile).ino;

    store.recordDreamSuccess('2026-08-08');

    assert.notEqual(statSync(home.maintenanceStateFile).ino, firstInode);
    assert.equal(store.loadOrBootstrap(workspace, '2026-08-09'), '2026-08-08');
    assert.throws(
      () => store.recordDreamSuccess('2026-08-07'),
      (error) =>
        error instanceof MaintenanceStateError && error.code === 'maintenance_state_invalid',
    );
  });
});

test('maintenance state refuses invalid documents and symlinks without treating them as success', () => {
  withFixture(({ root, home, workspace }) => {
    writeFileSync(home.maintenanceStateFile, '{"schemaVersion":1,"dream":{}}', { mode: 0o600 });
    assert.throws(
      () => createMaintenanceStateStore(home).loadOrBootstrap(workspace, '2026-08-08'),
      (error) =>
        error instanceof MaintenanceStateError && error.code === 'maintenance_state_invalid',
    );

    rmSync(home.maintenanceStateFile);
    const target = path.join(root, 'outside.json');
    writeFileSync(target, '{"outside":true}', { mode: 0o644 });
    chmodSync(target, 0o644);
    symlinkSync(target, home.maintenanceStateFile);

    assert.throws(
      () => createMaintenanceStateStore(home).loadOrBootstrap(workspace, '2026-08-08'),
      (error) =>
        error instanceof MaintenanceStateError && error.code === 'maintenance_state_unsafe',
    );
    assert.equal(readFileSync(target, 'utf8'), '{"outside":true}');
    assert.equal(lstatSync(target).mode & 0o777, 0o644);
  });
});
