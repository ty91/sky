import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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
    runtimes: [],
  };
  let client;

  const connection = {
    calls,
    sessionUpdate: async (params) => {
      if (!client) {
        throw new Error('ACP test client was not initialized');
      }
      await client.sessionUpdate(params);
    },
    requestPermission: async (params) => {
      if (!client) {
        throw new Error('ACP test client was not initialized');
      }
      return client.requestPermission(params);
    },
    createAgentConnection: (nextClient, runtime) => {
      client = nextClient;
      calls.runtimes.push(runtime);
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
  assert.equal(fake.calls.runtimes[0].command, process.execPath);
  assert.match(fake.calls.runtimes[0].args[0], /claude-agent-acp/);
  assert.equal(fake.calls.newSession[0]._meta.systemPrompt, 'system');
  assert.equal(fake.calls.newSession[0]._meta.claudeCode.options.model, 'claude-opus-4-7');
  assert.deepEqual(fake.calls.newSession[0]._meta.claudeCode.options.settingSources, []);
  assert.deepEqual(fake.calls.prompt[0].prompt, [{ type: 'text', text: 'hi' }]);
});

test('ACP provider selects Codex ACP runtime for openai models', () => {
  const fake = createFakeConnection();
  const systemPrompt = 'system "quoted"\nnext';
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalSecret = process.env.SKY_SECRET_FOR_TEST;

  try {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SKY_SECRET_FOR_TEST = 'hidden';

    createAcpProviderFactory({
      cwd: '/tmp/workspace',
      createAgentConnection: fake.createAgentConnection,
    }).create({ ...BASE_CONFIG, model: 'openai/gpt-5.5', systemPrompt });

    const runtime = fake.calls.runtimes[0];
    assert.equal(path.basename(runtime.command), process.platform === 'win32' ? 'codex-acp.exe' : 'codex-acp');
    assert.deepEqual(runtime.args, [
      '-c',
      'model="gpt-5.5"',
      '-c',
      `developer_instructions=${JSON.stringify(systemPrompt)}`,
      '-c',
      'project_doc_max_bytes=0',
    ]);
    assert.equal(runtime.env.OPENAI_API_KEY, 'test-openai-key');
    assert.equal(runtime.env.SKY_SECRET_FOR_TEST, undefined);
  } finally {
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
    if (originalSecret === undefined) {
      delete process.env.SKY_SECRET_FOR_TEST;
    } else {
      process.env.SKY_SECRET_FOR_TEST = originalSecret;
    }
  }
});

test('ACP provider creates openai sessions without Claude metadata', async () => {
  const fake = createFakeConnection();
  const provider = createAcpProviderFactory({
    cwd: '/tmp/workspace',
    createAgentConnection: fake.createAgentConnection,
  }).create({ ...BASE_CONFIG, model: 'openai/gpt-5.5' });

  await provider.send('hi');
  const result = await provider.collect();

  assert.equal(result.sessionId, 'session-new');
  assert.equal(fake.calls.newSession.length, 1);
  assert.equal(fake.calls.newSession[0].cwd, '/tmp/workspace');
  assert.deepEqual(fake.calls.newSession[0].mcpServers, []);
  assert.equal('_meta' in fake.calls.newSession[0], false);
});

test('ACP provider flushes buffered text when a non-agent update arrives', async () => {
  const fake = createFakeConnection({
    prompt: async (params) => {
      fake.calls.prompt.push(params);
      await fake.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Before tool. ',
          },
        },
      });
      await fake.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Read',
          status: 'pending',
        },
      });
      await fake.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'After tool.',
          },
        },
      });
      return { stopReason: 'end_turn' };
    },
  });
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

  assert.deepEqual(result, { text: 'Before tool. After tool.', sessionId: 'session-new' });
  assert.deepEqual(streamed, ['Before tool. ', 'After tool.']);
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

test('ACP provider permission selection uses Claude tool metadata when present', async () => {
  const fake = createFakeConnection();
  createAcpProviderFactory({
    cwd: '/tmp/workspace',
    createAgentConnection: fake.createAgentConnection,
  }).create({ ...BASE_CONFIG, tools: ['Read'] });

  const response = await fake.requestPermission({
    toolCall: {
      title: 'Write',
      _meta: {
        claudeCode: {
          toolName: 'Read',
        },
      },
    },
    options: [
      { optionId: 'allow-read', kind: 'allow_once' },
      { optionId: 'reject-read', kind: 'reject_once' },
    ],
  });

  assert.deepEqual(response, {
    outcome: {
      outcome: 'selected',
      optionId: 'allow-read',
    },
  });
});

test('ACP provider permission selection falls back to tool title', async () => {
  const fake = createFakeConnection();
  createAcpProviderFactory({
    cwd: '/tmp/workspace',
    createAgentConnection: fake.createAgentConnection,
  }).create({ ...BASE_CONFIG, tools: ['Read'] });

  const response = await fake.requestPermission({
    toolCall: {
      title: 'Write',
      _meta: {},
    },
    options: [
      { optionId: 'allow-write', kind: 'allow_once' },
      { optionId: 'reject-write', kind: 'reject_once' },
    ],
  });

  assert.deepEqual(response, {
    outcome: {
      outcome: 'selected',
      optionId: 'reject-write',
    },
  });
});

test('ACP provider permission selection rejects unknown tool names when tools are configured', async () => {
  const fake = createFakeConnection();
  createAcpProviderFactory({
    cwd: '/tmp/workspace',
    createAgentConnection: fake.createAgentConnection,
  }).create({ ...BASE_CONFIG, tools: ['Read'] });

  const response = await fake.requestPermission({
    toolCall: {
      _meta: {},
    },
    options: [
      { optionId: 'allow-unknown', kind: 'allow_once' },
      { optionId: 'reject-unknown', kind: 'reject_once' },
    ],
  });

  assert.deepEqual(response, {
    outcome: {
      outcome: 'selected',
      optionId: 'reject-unknown',
    },
  });
});

test('ACP provider permission selection allows unknown tool names without a tools allowlist', async () => {
  const fake = createFakeConnection();
  createAcpProviderFactory({
    cwd: '/tmp/workspace',
    createAgentConnection: fake.createAgentConnection,
  }).create({ ...BASE_CONFIG, tools: undefined });

  const response = await fake.requestPermission({
    toolCall: {
      _meta: {},
    },
    options: [
      { optionId: 'allow-unknown', kind: 'allow_once' },
      { optionId: 'reject-unknown', kind: 'reject_once' },
    ],
  });

  assert.deepEqual(response, {
    outcome: {
      outcome: 'selected',
      optionId: 'allow-unknown',
    },
  });
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
      }).create({ ...BASE_CONFIG, model: 'google/gemini-pro' }),
    /Unsupported model provider: google/,
  );
});
