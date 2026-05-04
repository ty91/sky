import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcpProviderFactory } from '../dist/providers/acp.js';

const BASE_CONFIG = {
  sessionKey: 'thread-1',
  systemPrompt: 'system',
  model: 'anthropic/claude-opus-4-7',
  tools: ['Read'],
  cwd: '/tmp/workspace',
};

function createFakeConnection(overrides = {}) {
  const calls = {
    initialize: 0,
    newSession: [],
    resumeSession: [],
    loadSession: [],
    prompt: [],
    cancel: [],
    closeSession: [],
    close: 0,
  };
  let client;

  const connection = {
    calls,
    createAgentConnection: (nextClient) => {
      client = nextClient;
      return {
        initialize: async () => {
          calls.initialize++;
          return {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: {
                resume: {},
                close: {},
              },
            },
          };
        },
        newSession: async (params) => {
          calls.newSession.push(params);
          return { sessionId: 'session-new' };
        },
        resumeSession: async (params) => {
          calls.resumeSession.push(params);
          return {};
        },
        loadSession: async (params) => {
          calls.loadSession.push(params);
          return {};
        },
        prompt: async (params) => {
          calls.prompt.push(params);
          for (const text of ['hello ', 'from ', 'acp']) {
            await client.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text,
                },
              },
            });
          }
          return { stopReason: 'end_turn' };
        },
        cancel: async (params) => {
          calls.cancel.push(params);
        },
        closeSession: async (params) => {
          calls.closeSession.push(params);
          return {};
        },
        close: async () => {
          calls.close++;
        },
        ...overrides,
      };
    },
  };

  return connection;
}

test('ACP provider creates a session and collects buffered text chunks', async () => {
  const fake = createFakeConnection();
  const provider = createAcpProviderFactory({
    cwd: '/tmp/workspace',
    createAgentConnection: fake.createAgentConnection,
  }).create(BASE_CONFIG);
  const streamed = [];

  await provider.send('hi');
  const result = await provider.collect({
    onMessage: async (text) => {
      streamed.push(text);
    },
  });

  assert.deepEqual(result, { text: 'hello from acp', sessionId: 'session-new' });
  assert.deepEqual(streamed, ['hello from acp']);
  assert.equal(fake.calls.initialize, 1);
  assert.equal(fake.calls.newSession.length, 1);
  assert.equal(fake.calls.newSession[0]._meta.systemPrompt, 'system');
  assert.equal(fake.calls.newSession[0]._meta.claudeCode.options.model, 'claude-opus-4-7');
  assert.deepEqual(fake.calls.newSession[0]._meta.claudeCode.options.settingSources, []);
  assert.deepEqual(fake.calls.prompt[0].prompt, [{ type: 'text', text: 'hi' }]);
});

test('ACP provider maps interrupt to session cancel', async () => {
  const fake = createFakeConnection();
  const provider = createAcpProviderFactory({
    cwd: '/tmp/workspace',
    createAgentConnection: fake.createAgentConnection,
  }).create({ ...BASE_CONFIG, resume: 'session-existing' });

  await provider.interrupt();

  assert.deepEqual(fake.calls.cancel, [{ sessionId: 'session-existing' }]);
});

test('ACP provider falls back to new session when resume and load fail', async () => {
  const fake = createFakeConnection({
    resumeSession: async (params) => {
      fake.calls.resumeSession.push(params);
      throw new Error('missing resume');
    },
    loadSession: async (params) => {
      fake.calls.loadSession.push(params);
      throw new Error('missing load');
    },
  });
  const provider = createAcpProviderFactory({
    cwd: '/tmp/workspace',
    createAgentConnection: fake.createAgentConnection,
  }).create({ ...BASE_CONFIG, resume: 'session-old' });

  await provider.send('hi');
  const result = await provider.collect();

  assert.equal(result.sessionId, 'session-new');
  assert.equal(fake.calls.resumeSession.length, 1);
  assert.equal(fake.calls.loadSession.length, 1);
  assert.equal(fake.calls.newSession.length, 1);
});

test('ACP provider surfaces prompt errors', async () => {
  const fake = createFakeConnection({
    prompt: async (params) => {
      fake.calls.prompt.push(params);
      throw new Error('json-rpc failed');
    },
  });
  const provider = createAcpProviderFactory({
    cwd: '/tmp/workspace',
    createAgentConnection: fake.createAgentConnection,
  }).create(BASE_CONFIG);

  await provider.send('hi');

  await assert.rejects(() => provider.collect(), /json-rpc failed/);
});

test('ACP provider surfaces initialization errors', async () => {
  const fake = createFakeConnection({
    initialize: async () => {
      fake.calls.initialize++;
      throw new Error('agent process exited');
    },
  });
  const provider = createAcpProviderFactory({
    cwd: '/tmp/workspace',
    createAgentConnection: fake.createAgentConnection,
  }).create(BASE_CONFIG);

  await provider.send('hi');

  await assert.rejects(() => provider.collect(), /agent process exited/);
});

test('ACP provider rejects unsupported model providers', () => {
  const fake = createFakeConnection();
  assert.throws(
    () =>
      createAcpProviderFactory({
        cwd: '/tmp/workspace',
        createAgentConnection: fake.createAgentConnection,
      }).create({ ...BASE_CONFIG, model: 'openai/gpt-5-5' }),
    /Unsupported model provider: openai/,
  );
});
