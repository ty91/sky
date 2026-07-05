import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultAgentSessionFactory,
  resolveAgentSessionFactory,
} from '../dist/agents/backend/index.js';

test('resolveAgentSessionFactory uses pi as the configured pi backend', () => {
  const createSession = resolveAgentSessionFactory('pi');

  assert.equal(createSession, createDefaultAgentSessionFactory);
  assert.equal(createSession.backend, 'pi');
});

test('resolveAgentSessionFactory exposes a clear pending error for claude-agent-sdk', async () => {
  const createSession = resolveAgentSessionFactory('claude-agent-sdk');

  assert.equal(createSession.backend, 'claude-agent-sdk');
  await assert.rejects(
    () =>
      createSession({
        key: 'thread-1',
        agent: {
          name: 'main',
          systemPrompt: 'system',
        },
        cwd: '/tmp/workspace',
      }),
    /Claude Agent SDK backend is not implemented yet/,
  );
});
