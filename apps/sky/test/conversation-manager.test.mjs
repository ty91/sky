import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationManager } from '../dist/conversation/manager.js';
import { openConversationStore } from '../dist/conversation/store.js';

const AGENT = {
  name: 'main',
  systemPrompt: 'system',
  model: 'anthropic/claude-opus-4-7',
  tools: ['read', 'bash'],
};

function createFakeAgentSession({
  sessionId = 'agent-session-1',
  systemPrompt,
  onPrompt,
  onAbort,
  ...options
} = {}) {
  const resumeRef = Object.hasOwn(options, 'resumeRef') ? options.resumeRef : '/tmp/pi-session-1.jsonl';
  const listeners = new Set();
  return {
    sessionId,
    ...(resumeRef !== undefined ? { resumeRef } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    prompt: async (text) => {
      if (onPrompt) {
        await onPrompt(text, (event) => {
          for (const listener of listeners) listener(event);
        });
        return;
      }
      for (const listener of listeners) {
        listener({
          type: 'text_delta',
          delta: `reply to ${text}`,
        });
        listener({
          type: 'assistant_message',
          text: `reply to ${text}`,
        });
        listener({
          type: 'turn_end',
          text: `reply to ${text}`,
        });
      }
    },
    abort: async () => {
      await onAbort?.();
    },
    dispose: () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const SLACK_THREAD = { provider: 'slack', externalId: 'D123:1799971200.000100' };

function createSessionFactory(createSession, backend = 'pi') {
  return Object.assign(createSession, { backend });
}

function sequentialIds() {
  let next = 0;
  return () => `conversation-${++next}`;
}

test('conversation manager creates an agent session for a new conversation and returns final text with handle', async () => {
  const created = [];
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    createSession: createSessionFactory(async (config) => {
      created.push(config);
      return createFakeAgentSession();
    }),
  });

  const conversationId = manager.create();
  const result = await manager.runTurn(conversationId, AGENT, 'hello');

  assert.deepEqual(result, {
    kind: 'ok',
    text: 'reply to hello',
    messages: ['reply to hello'],
    handle: {
      sessionId: 'agent-session-1',
      sessionFile: '/tmp/pi-session-1.jsonl',
    },
  });
  assert.deepEqual(created, [{
    conversation: { id: conversationId, links: [] },
    agent: AGENT,
    cwd: '/tmp/workspace',
  }]);
});

test('conversation manager refuses a turn for a conversation that was never created', async () => {
  const created = [];
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store: openConversationStore(':memory:'),
    createSession: createSessionFactory(async (config) => {
      created.push(config);
      return createFakeAgentSession();
    }),
  });

  const result = await manager.runTurn('D123:1799971200.000100', AGENT, 'hello');

  assert.equal(result.kind, 'error');
  assert.equal(result.error.name, 'UnknownConversationError');
  assert.deepEqual(created, []);
  assert.equal(manager.activeWorkCount(), 0);
});

test('conversation manager resolves an external link to the same conversation and hands its links to the session', async () => {
  const created = [];
  const store = openConversationStore(':memory:', { createId: sequentialIds() });
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: createSessionFactory(async (config) => {
      created.push(config);
      return createFakeAgentSession();
    }),
  });

  assert.equal(manager.find(SLACK_THREAD), undefined);
  const conversationId = manager.ensure(SLACK_THREAD);
  assert.equal(manager.ensure(SLACK_THREAD), conversationId);
  assert.equal(manager.find(SLACK_THREAD), conversationId);

  await manager.runTurn(conversationId, AGENT, 'hello');

  assert.deepEqual(created[0].conversation, { id: 'conversation-1', links: [SLACK_THREAD] });
  assert.deepEqual((await manager.list()).map(({ conversationId: id, links }) => ({ id, links })), [
    { id: 'conversation-1', links: [SLACK_THREAD] },
  ]);
});

test('conversation manager persists the backend session and resumes it after restart', async () => {
  const store = openConversationStore(':memory:');
  const first = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: createSessionFactory(async () =>
      createFakeAgentSession({
        sessionId: 'agent-session-persisted',
        resumeRef: '/tmp/pi-session-persisted.jsonl',
        systemPrompt: 'frozen prompt',
      }),
    ),
  });
  const conversationId = first.ensure(SLACK_THREAD);
  assert.equal((await first.runTurn(conversationId, AGENT, 'hello')).kind, 'ok');
  assert.deepEqual(store.getSession(conversationId, 'pi'), {
    sessionId: 'agent-session-persisted',
    backend: 'pi',
    resumeRef: '/tmp/pi-session-persisted.jsonl',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
    systemPrompt: 'frozen prompt',
  });
  await first.closeAll();

  const created = [];
  const afterRestart = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: createSessionFactory(async (config) => {
      created.push(config);
      return createFakeAgentSession({
        sessionId: 'agent-session-persisted',
        resumeRef: '/tmp/pi-session-persisted.jsonl',
      });
    }),
  });

  const result = await afterRestart.runTurn(afterRestart.find(SLACK_THREAD), AGENT, 'hello again');

  assert.equal(result.kind, 'ok');
  assert.deepEqual(created[0].resume, {
    sessionId: 'agent-session-persisted',
    resumeRef: '/tmp/pi-session-persisted.jsonl',
    systemPrompt: 'frozen prompt',
  });
});

test('conversation manager persists handles that only have a session id and the injected backend', async () => {
  const store = openConversationStore(':memory:');
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: createSessionFactory(
      async () => createFakeAgentSession({ sessionId: 'claude-session-1', resumeRef: undefined }),
      'claude-agent-sdk',
    ),
  });

  const conversationId = manager.create();
  assert.equal((await manager.runTurn(conversationId, AGENT, 'hello')).kind, 'ok');

  assert.deepEqual(store.getSession(conversationId, 'claude-agent-sdk'), {
    sessionId: 'claude-session-1',
    backend: 'claude-agent-sdk',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });
  assert.equal(store.getSession(conversationId, 'pi'), undefined);
});

test('conversation manager has/getHandle/purge cover in-memory and persisted sessions of the current backend', async () => {
  const store = openConversationStore(':memory:');
  const persisted = store.create().id;
  store.putSession(persisted, {
    sessionId: 'pi-session-persisted',
    backend: 'pi',
    resumeRef: '/tmp/pi-session-persisted.jsonl',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });
  const otherAgent = store.create().id;
  store.putSession(otherAgent, {
    sessionId: 'pi-session-other',
    backend: 'pi',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'memory',
  });
  const otherBackend = store.create().id;
  store.putSession(otherBackend, {
    sessionId: 'claude-session-other',
    backend: 'claude-agent-sdk',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: createSessionFactory(async () =>
      createFakeAgentSession({ sessionId: 'agent-session-open' }),
    ),
  });

  assert.equal(manager.has('missing', AGENT), false);
  assert.equal(manager.has(persisted, AGENT), true);
  assert.equal(manager.has(otherAgent, AGENT), false);
  assert.equal(manager.has(otherAgent), true);
  assert.equal(manager.has(otherBackend, AGENT), false);
  assert.deepEqual(manager.getHandle(persisted, AGENT), {
    sessionId: 'pi-session-persisted',
    sessionFile: '/tmp/pi-session-persisted.jsonl',
  });

  const open = manager.create();
  assert.equal(manager.has(open, AGENT), false);
  assert.equal((await manager.runTurn(open, AGENT, 'hello')).kind, 'ok');
  assert.equal(manager.has(open, AGENT), true);
  assert.equal(manager.has(open, { ...AGENT, name: 'memory' }), false);
  assert.deepEqual(manager.getHandle(open, AGENT), {
    sessionId: 'agent-session-open',
    sessionFile: '/tmp/pi-session-1.jsonl',
  });

  assert.equal(await manager.purge(open), true);
  assert.equal(await manager.purge(persisted), true);
  assert.equal(await manager.purge(persisted), false);

  assert.equal(manager.has(open, AGENT), false);
  assert.equal(manager.has(persisted, AGENT), false);
  assert.equal(store.getSession(open, 'pi'), undefined);
  assert.equal(store.getSession(persisted, 'pi'), undefined);
  assert.equal(store.get(persisted)?.id, persisted);
  assert.equal(store.getSession(otherBackend, 'claude-agent-sdk')?.sessionId, 'claude-session-other');
});

test('conversation manager keeps each backend slot and replaces only the current slot when the model changes', async () => {
  const store = openConversationStore(':memory:');
  const conversationId = store.create({ link: SLACK_THREAD }).id;
  store.putSession(conversationId, {
    sessionId: 'claude-session-kept',
    backend: 'claude-agent-sdk',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });
  store.putSession(conversationId, {
    sessionId: 'pi-session-old-model',
    backend: 'pi',
    model: 'anthropic/claude-sonnet-4-6',
    agentName: 'main',
  });
  const created = [];
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: createSessionFactory(async (config) => {
      created.push(config);
      return createFakeAgentSession({ sessionId: 'pi-session-new-model' });
    }),
  });

  assert.equal((await manager.runTurn(conversationId, AGENT, 'hello')).kind, 'ok');

  assert.equal(created[0].resume, undefined);
  assert.equal(store.getSession(conversationId, 'pi')?.sessionId, 'pi-session-new-model');
  assert.equal(store.getSession(conversationId, 'pi')?.model, 'anthropic/claude-opus-4-7');
  assert.equal(store.getSession(conversationId, 'claude-agent-sdk')?.sessionId, 'claude-session-kept');
  assert.equal(manager.find(SLACK_THREAD), conversationId);
});

test('conversation manager forwards agent text deltas to the caller callback', async () => {
  const deltas = [];
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    createSession: createSessionFactory(async () =>
      createFakeAgentSession({
        onPrompt: async (_text, emit) => {
          emit({
            type: 'text_delta',
            delta: 'hello ',
          });
          emit({
            type: 'thinking_delta',
            delta: 'hidden',
          });
          emit({
            type: 'text_delta',
            delta: 'world',
          });
          emit({
            type: 'assistant_message',
            text: 'hello world',
          });
          emit({
            type: 'turn_end',
            text: 'hello world',
          });
        },
      }),
    ),
  });

  const result = await manager.runTurn(manager.create(), AGENT, 'hello', {
    onTextDelta: async (delta) => {
      deltas.push(delta);
    },
  });

  assert.deepEqual(deltas, ['hello ', 'world']);
  assert.equal(result.kind, 'ok');
  assert.equal(result.text, 'hello world');
  assert.deepEqual(result.messages, ['hello world']);
});

test('conversation manager keeps assistant message boundaries when the backend emits them', async () => {
  const delivered = [];
  let firstDeliveredBeforePromptFinished = false;
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    createSession: createSessionFactory(async () =>
      createFakeAgentSession({
        onPrompt: async (_text, emit) => {
          emit({
            type: 'text_delta',
            delta: 'first',
          });
          emit({
            type: 'assistant_message',
            text: 'first',
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
          firstDeliveredBeforePromptFinished = delivered.includes('first');
          emit({
            type: 'text_delta',
            delta: 'second',
          });
          emit({
            type: 'assistant_message',
            text: 'second',
          });
        },
      }),
    ),
  });

  const result = await manager.runTurn(manager.create(), AGENT, 'hello', {
    onMessage: async (message) => {
      delivered.push(message);
    },
  });

  assert.equal(result.kind, 'ok');
  assert.equal(result.text, 'firstsecond');
  assert.deepEqual(result.messages, ['first', 'second']);
  assert.deepEqual(delivered, ['first', 'second']);
  assert.equal(firstDeliveredBeforePromptFinished, true);
});

test('conversation manager interrupts an active turn and lets the latest turn complete', async () => {
  let promptCount = 0;
  let releaseFirstPrompt;
  let abortCount = 0;

  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    createSession: createSessionFactory(async () =>
      createFakeAgentSession({
        onPrompt: async (text, emit) => {
          promptCount += 1;
          if (promptCount === 1) {
            emit({
              type: 'text_delta',
              delta: `stale:${text}`,
            });
            await new Promise((resolve) => {
              releaseFirstPrompt = resolve;
            });
            return;
          }

          emit({
            type: 'text_delta',
            delta: `latest:${text}`,
          });
        },
        onAbort: async () => {
          abortCount += 1;
          releaseFirstPrompt?.();
        },
      }),
    ),
  });

  const conversationId = manager.create();
  const first = manager.runTurn(conversationId, AGENT, 'first');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const second = manager.runTurn(conversationId, AGENT, 'second');
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(firstResult, { kind: 'interrupted' });
  assert.equal(secondResult.kind, 'ok');
  assert.equal(secondResult.text, 'latest:second');
  assert.equal(abortCount, 1);
});

test('conversation manager applies the conversation model to every entry point', async () => {
  const store = openConversationStore(':memory:');
  const created = [];
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: createSessionFactory(async (config) => {
      created.push(config);
      return createFakeAgentSession({ sessionId: `session-${created.length}` });
    }),
  });
  const fable = manager.ensure(SLACK_THREAD);
  manager.setModel(fable, 'anthropic/claude-fable-5');
  const untouched = manager.create();

  assert.equal((await manager.runTurn(fable, AGENT, 'hello')).kind, 'ok');
  assert.equal((await manager.runTurn(untouched, AGENT, 'hello')).kind, 'ok');

  assert.equal(created[0].agent.model, 'anthropic/claude-fable-5');
  // The override is a copy; the shared agent config is never mutated.
  assert.equal(AGENT.model, 'anthropic/claude-opus-4-7');
  assert.equal(created[1].agent, AGENT);
  assert.equal(store.getSession(fable, 'pi')?.model, 'anthropic/claude-fable-5');
  assert.equal(store.getSession(untouched, 'pi')?.model, 'anthropic/claude-opus-4-7');

  // `has`/`getHandle` resolve the same override, so an ownership check made
  // with the default agent config still finds the overridden conversation.
  assert.equal(manager.has(fable, AGENT), true);
  assert.equal(manager.getHandle(fable, AGENT).sessionId, 'session-1');
});

test('conversation manager resumes an overridden conversation instead of forking a new session', async () => {
  // Mirrors a proactive turn (scheduled reminder / post-restart trigger) that
  // runs with the default agent config after a restart: the persisted record
  // holds the conversation's chosen model, so without the override the
  // ownership check would fail and silently start a fresh session.
  const store = openConversationStore(':memory:');
  const conversationId = store.create({ link: SLACK_THREAD, model: 'anthropic/claude-fable-5' }).id;
  store.putSession(conversationId, {
    sessionId: 'session-existing',
    backend: 'pi',
    resumeRef: '/tmp/pi-session-existing.jsonl',
    model: 'anthropic/claude-fable-5',
    agentName: 'main',
  });
  const created = [];
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: createSessionFactory(async (config) => {
      created.push(config);
      return createFakeAgentSession({ sessionId: 'session-existing' });
    }),
  });

  const result = await manager.runTurn(conversationId, AGENT, 'hello');

  assert.equal(result.kind, 'ok');
  assert.deepEqual(created[0].resume, {
    sessionId: 'session-existing',
    resumeRef: '/tmp/pi-session-existing.jsonl',
  });
});
