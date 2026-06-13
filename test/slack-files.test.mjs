import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { ReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSlackFileUploader, SlackFileUploadError } from '../dist/slack/files.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sky-slack-files-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('Slack file uploader uploads each path with uploadV2 and normalizes results', async () => {
  await withTempDir(async (dir) => {
    const first = path.join(dir, 'first.txt');
    const second = path.join(dir, 'second.md');
    await writeFile(first, 'first', 'utf8');
    await writeFile(second, 'second', 'utf8');

    const uploadCalls = [];
    const uploader = createSlackFileUploader({
      files: {
        uploadV2: async (params) => {
          uploadCalls.push(params);
          return {
            ok: true,
            file: { id: `F${uploadCalls.length}` },
          };
        },
      },
    });

    const results = await uploader.uploadFiles({
      channelId: 'C123',
      threadTs: '1777901000.000000',
      paths: [first, second],
    });

    assert.deepEqual(results, [
      { path: first, fileId: 'F1' },
      { path: second, fileId: 'F2' },
    ]);
    assert.equal(uploadCalls.length, 2);

    assert.equal(uploadCalls[0].channel_id, 'C123');
    assert.equal(uploadCalls[0].thread_ts, '1777901000.000000');
    assert.equal(uploadCalls[0].filename, 'first.txt');
    assert.ok(uploadCalls[0].file instanceof ReadStream);
    assert.equal('initial_comment' in uploadCalls[0], false);
    assert.equal('comment' in uploadCalls[0], false);
    assert.equal('title' in uploadCalls[0], false);

    assert.equal(uploadCalls[1].channel_id, 'C123');
    assert.equal(uploadCalls[1].thread_ts, '1777901000.000000');
    assert.equal(uploadCalls[1].filename, 'second.md');
    assert.ok(uploadCalls[1].file instanceof ReadStream);
    assert.equal('initial_comment' in uploadCalls[1], false);
    assert.equal('comment' in uploadCalls[1], false);
    assert.equal('title' in uploadCalls[1], false);
  });
});

test('Slack file uploader continues after per-file upload failures', async () => {
  await withTempDir(async (dir) => {
    const first = path.join(dir, 'first.txt');
    const second = path.join(dir, 'second.txt');
    const third = path.join(dir, 'third.txt');
    await writeFile(first, 'first', 'utf8');
    await writeFile(second, 'second', 'utf8');
    await writeFile(third, 'third', 'utf8');

    const uploadCalls = [];
    const uploader = createSlackFileUploader({
      files: {
        uploadV2: async (params) => {
          uploadCalls.push(params);
          if (params.filename === 'second.txt') {
            throw new Error('Slack rejected second');
          }
          return {
            ok: true,
            file: { id: `F${uploadCalls.length}` },
          };
        },
      },
    });

    await assert.rejects(
      () =>
        uploader.uploadFiles({
          channelId: 'C123',
          threadTs: '1777901000.000000',
          paths: [first, second, third],
        }),
      (error) => {
        assert.ok(error instanceof SlackFileUploadError);
        assert.deepEqual(error.successes, [
          { path: first, fileId: 'F1' },
          { path: third, fileId: 'F3' },
        ]);
        assert.deepEqual(error.failures, [{ path: second, reason: 'Slack rejected second' }]);
        return true;
      },
    );

    assert.deepEqual(
      uploadCalls.map((call) => call.filename),
      ['first.txt', 'second.txt', 'third.txt'],
    );
  });
});
