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

test('resolveAgentSessionFactory exposes the claude-agent-sdk backend', () => {
  const createSession = resolveAgentSessionFactory('claude-agent-sdk');

  assert.equal(createSession.backend, 'claude-agent-sdk');
});
