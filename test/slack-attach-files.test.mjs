import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSlackAttachFilesTool } from '../dist/agents/tools/slack-attach-files.js';
import { SlackFileUploadError } from '../dist/slack/files.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sky-attach-files-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createCountingUploader() {
  const calls = [];
  return {
    calls,
    uploader: {
      uploadFiles: async (params) => {
        calls.push(params);
        return params.paths.map((filePath, index) => ({ path: filePath, fileId: `F${index + 1}` }));
      },
    },
  };
}

test('slack_attach_files rejects empty paths before uploading', async () => {
  await withTempDir(async () => {
    const { calls, uploader } = createCountingUploader();

    await assert.rejects(
      () => runSlackAttachFilesTool({ channelId: 'C123', threadTs: '1777901000.000000' }, { paths: [] }, uploader),
      /paths must include at least one file/,
    );

    assert.deepEqual(calls, []);
  });
});

test('slack_attach_files rejects invalid local files before uploading', async () => {
  await withTempDir(async (dir) => {
    const missing = path.join(dir, 'missing.txt');
    const directory = path.join(dir, 'directory');
    const unreadable = path.join(dir, 'unreadable.txt');
    await mkdir(directory);
    await writeFile(unreadable, 'secret', 'utf8');
    await chmod(unreadable, 0o000);

    try {
      const { calls, uploader } = createCountingUploader();

      await assert.rejects(
        () =>
          runSlackAttachFilesTool(
            { channelId: 'C123', threadTs: '1777901000.000000' },
            { paths: ['   ', missing, directory, unreadable] },
            uploader,
          ),
        (error) => {
          assert.match(error.message, /path must be a non-empty string/);
          assert.match(error.message, /missing\.txt/);
          assert.match(error.message, /directory: path is not a regular file/);
          assert.match(error.message, /unreadable\.txt/);
          return true;
        },
      );

      assert.deepEqual(calls, []);
    } finally {
      await chmod(unreadable, 0o600);
    }
  });
});

test('slack_attach_files uploads deduped valid files and returns details', async () => {
  await withTempDir(async (dir) => {
    const first = path.join(dir, 'first.txt');
    const second = path.join(dir, 'second.txt');
    await writeFile(first, 'first', 'utf8');
    await writeFile(second, 'second', 'utf8');
    const { calls, uploader } = createCountingUploader();

    const result = await runSlackAttachFilesTool(
      { channelId: 'C123', threadTs: '1777901000.000000' },
      { paths: [first, ` ${first} `, second] },
      uploader,
    );

    assert.deepEqual(calls, [
      {
        channelId: 'C123',
        threadTs: '1777901000.000000',
        paths: [first, second],
      },
    ]);
    assert.match(result.content[0].text, /Uploaded 2 file/);
    assert.deepEqual(result.details, {
      channelId: 'C123',
      threadTs: '1777901000.000000',
      uploadedCount: 2,
      uploadedPaths: [first, second],
      uploads: [
        { path: first, fileId: 'F1' },
        { path: second, fileId: 'F2' },
      ],
    });
  });
});

test('slack_attach_files reports Slack partial upload failures with successes', async () => {
  await withTempDir(async (dir) => {
    const first = path.join(dir, 'first.txt');
    const second = path.join(dir, 'second.txt');
    await writeFile(first, 'first', 'utf8');
    await writeFile(second, 'second', 'utf8');

    const calls = [];
    const uploader = {
      uploadFiles: async (params) => {
        calls.push(params);
        throw new SlackFileUploadError(
          'partial failure',
          [{ path: first, fileId: 'F1' }],
          [{ path: second, reason: 'slack unavailable' }],
        );
      },
    };

    await assert.rejects(
      () =>
        runSlackAttachFilesTool(
          { channelId: 'C123', threadTs: '1777901000.000000' },
          { paths: [first, second] },
          uploader,
        ),
      (error) => {
        assert.match(error.message, /second\.txt: slack unavailable/);
        assert.match(error.message, /Uploaded before failure: .*first\.txt/);
        return true;
      },
    );

    assert.deepEqual(calls, [
      {
        channelId: 'C123',
        threadTs: '1777901000.000000',
        paths: [first, second],
      },
    ]);
  });
});
