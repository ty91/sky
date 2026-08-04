import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createClaudeAgentSdkSessionFactory } from '../dist/agents/backend/claude.js';
import { createClaudeCodeExecutableResolver } from '../dist/claude-code-executable.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function createQuery(run, methods = {}) {
  const iterator = run();
  return Object.assign(iterator, {
    interrupt: async () => {},
    close: () => {},
    ...methods,
  });
}

function initMessage(sessionId) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    tools: [],
    mcp_servers: [],
  };
}

function textDelta(sessionId, text) {
  return {
    type: 'stream_event',
    session_id: sessionId,
    event: {
      type: 'content_block_delta',
      delta: {
        type: 'text_delta',
        text,
      },
    },
  };
}

function assistantMessage(sessionId, text) {
  return {
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { content: [{ type: 'text', text }] },
  };
}

function successResult(sessionId, result = 'hello world') {
  return {
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    is_error: false,
    result,
  };
}

function errorResult(sessionId) {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    session_id: sessionId,
    is_error: true,
    errors: ['interrupted'],
  };
}

function createFakeDeps({ env, query, diagnostics, resolveClaudeCodeExecutable }) {
  const toolCalls = [];
  const mcpServerCalls = [];
  return {
    deps: {
      env,
      query,
      diagnostics,
      ...(resolveClaudeCodeExecutable ? { resolveClaudeCodeExecutable } : {}),
      tool: (name, description, inputSchema, handler, extras) => {
        const toolDef = { name, description, inputSchema, handler, extras };
        toolCalls.push(toolDef);
        return toolDef;
      },
      createSdkMcpServer: (options) => {
        mcpServerCalls.push(options);
        return { type: 'sdk', name: options.name, instance: { name: options.name } };
      },
    },
    toolCalls,
    mcpServerCalls,
  };
}

test('embedded claude executable extraction stays lazy and reuses its first result', () => {
  const extractedPaths = [];
  const resolveExecutable = createClaudeCodeExecutableResolver('/$bunfs/root/claude', (input) => {
    extractedPaths.push(input);
    return '/tmp/claude-agent-sdk-content-hash/claude';
  });

  assert.deepEqual(extractedPaths, []);
  assert.equal(resolveExecutable(), '/tmp/claude-agent-sdk-content-hash/claude');
  assert.equal(resolveExecutable(), '/tmp/claude-agent-sdk-content-hash/claude');
  assert.deepEqual(extractedPaths, ['/$bunfs/root/claude']);
});

test('claude agent sdk resolves and passes a standalone executable only when a query starts', async () => {
  const queryOptions = [];
  let resolverCalls = 0;
  const { deps } = createFakeDeps({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
    resolveClaudeCodeExecutable: () => {
      resolverCalls += 1;
      return '/tmp/claude-agent-sdk-helper/claude';
    },
    query: (params) => {
      queryOptions.push(params.options);
      return createQuery(async function* () {
        const input = params.prompt[Symbol.asyncIterator]();
        await input.next();
        yield initMessage('claude-session-standalone');
        yield successResult('claude-session-standalone');
        await input.next();
      });
    },
  });
  const createSession = createClaudeAgentSdkSessionFactory(deps);

  assert.equal(resolverCalls, 0);
  const session = await createSession({
    key: 'thread-standalone',
    cwd: '/tmp/workspace',
    agent: { name: 'main', systemPrompt: 'system' },
  });
  assert.equal(resolverCalls, 0);

  await session.prompt('hello');

  assert.equal(resolverCalls, 1);
  assert.equal(
    queryOptions[0].pathToClaudeCodeExecutable,
    '/tmp/claude-agent-sdk-helper/claude',
  );
});

test('claude agent sdk factory fails fast without an OAuth token', async () => {
  const { deps } = createFakeDeps({
    env: {},
    query: () => {
      throw new Error('query should not be called');
    },
  });
  const createSession = createClaudeAgentSdkSessionFactory(deps);

  await assert.rejects(
    () =>
      createSession({
        key: 'thread-1',
        agent: { name: 'main', systemPrompt: 'system' },
        cwd: '/tmp/workspace',
      }),
    /CLAUDE_CODE_OAUTH_TOKEN/,
  );
});

test('claude agent sdk reports bounded startup stalls without exposing prompt or credentials', async () => {
  const releaseFirstMessage = deferred();
  const scheduled = [];
  const records = [];
  let elapsed = 0;
  const { deps } = createFakeDeps({
    env: {
      HOME: '/Users/tester',
      PATH: '/secret/bin',
      SHELL: '/bin/zsh',
      TERM: 'xterm-256color',
      LANG: 'ko_KR.UTF-8',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-must-not-leak',
    },
    diagnostics: {
      supervisionMode: 'launchd',
      createAttemptId: () => 'attempt-1',
      clock: () => elapsed,
      schedule: (delayMs, callback) => {
        const timer = { delayMs, callback, cancelled: false };
        scheduled.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      sink: (level, event, fields) => records.push({ level, event, fields }),
    },
    query: (params) =>
      createQuery(async function* () {
        const input = params.prompt[Symbol.asyncIterator]();
        await input.next();
        await releaseFirstMessage.promise;
        yield initMessage('claude-session-stall');
        yield successResult('claude-session-stall');
        await input.next();
      }),
  });
  const createSession = createClaudeAgentSdkSessionFactory(deps);
  const session = await createSession({
    key: 'thread-stall',
    cwd: '/tmp/workspace',
    agent: {
      name: 'main',
      systemPrompt: 'system',
      model: 'anthropic/claude-opus-4-7',
    },
  });

  const prompt = session.prompt('prompt-must-not-leak');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scheduled.map(({ delayMs }) => delayMs), [5_000, 15_000]);

  elapsed = 5_000;
  scheduled[0].callback();
  elapsed = 15_000;
  scheduled[1].callback();
  releaseFirstMessage.resolve();
  await prompt;

  assert.deepEqual(
    records.map(({ event }) => event),
    [
      'query_created',
      'input_enqueued',
      'first_message_stalled',
      'first_message_stalled',
      'first_sdk_message',
      'system_init',
      'result_received',
      'query_completed',
    ],
  );
  assert.deepEqual(
    records.filter(({ event }) => event === 'first_message_stalled').map(({ level }) => level),
    ['warn', 'error'],
  );
  assert.equal(records[2].fields.shell, '/bin/zsh');
  assert.equal(records[2].fields.term, 'xterm-256color');
  assert.equal(records[2].fields.lang, 'ko_KR.UTF-8');
  assert.equal(records[2].fields.path, undefined);
  assert.equal(records[3].fields.shell, undefined);
  assert.ok(scheduled.every(({ cancelled }) => cancelled));
  const serialized = JSON.stringify(records);
  assert.doesNotMatch(serialized, /prompt-must-not-leak|oauth-token-must-not-leak|secret\/bin/);
});

test('claude agent sdk session streams text and passes isolated per-turn query options', async (t) => {
  let queryParams;
  let observedUserMessage;
  let inputEnded = false;
  let loaderCalls = 0;
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'sky-claude-agent-sdk-'));
  mkdirSync(path.join(workspace, '.agents', 'skills'), { recursive: true });
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const { deps, toolCalls, mcpServerCalls } = createFakeDeps({
    env: {
      PATH: '/bin',
      HOME: '/tmp/home',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      ANTHROPIC_API_KEY: 'api-key-must-not-leak',
    },
    query: (params) => {
      queryParams = params;
      return createQuery(async function* () {
        const input = params.prompt[Symbol.asyncIterator]();
        const first = await input.next();
        observedUserMessage = first.value;
        yield initMessage('claude-session-1');
        yield textDelta('claude-session-1', 'hello ');
        yield textDelta('claude-session-1', 'world');
        yield assistantMessage('claude-session-1', 'hello world');
        yield successResult('claude-session-1');
        inputEnded = (await input.next()).done;
      });
    },
  });
  const createSession = createClaudeAgentSdkSessionFactory(deps);
  const session = await createSession({
    key: 'thread-1',
    cwd: workspace,
    agent: {
      name: 'main',
      systemPrompt: 'fallback',
      systemPromptLoader: () => `loaded-${++loaderCalls}`,
      model: 'anthropic/claude-opus-4-7',
      tools: ['Agent', 'Bash', 'Read', 'Skill', 'TodoWrite', 'TaskOutput', 'TaskStop', 'sample_tool'],
      maxTurns: 3,
      customToolsFactory: () => [
        {
          name: 'sample_tool',
          description: 'Run a sample custom tool',
          inputSchema: { reason: z.string().optional() },
          async execute(input) {
            return {
              content: [{ type: 'text', text: `scheduled:${input.reason}` }],
              details: { accepted: true },
            };
          },
        },
      ],
    },
  });
  const events = [];
  session.subscribe((event) => events.push(event));

  await session.prompt('say hello');

  assert.equal(session.sessionId, 'claude-session-1');
  assert.deepEqual(events, [
    { type: 'text_delta', delta: 'hello ' },
    { type: 'text_delta', delta: 'world' },
    { type: 'assistant_message', text: 'hello world' },
    { type: 'turn_end', text: 'hello world' },
  ]);
  assert.equal(inputEnded, true);
  assert.deepEqual(observedUserMessage, {
    type: 'user',
    message: { role: 'user', content: 'say hello' },
    parent_tool_use_id: null,
  });
  assert.equal(queryParams.options.cwd, workspace);
  assert.equal(queryParams.options.model, 'claude-opus-4-7');
  assert.equal(queryParams.options.pathToClaudeCodeExecutable, undefined);
  assert.equal(queryParams.options.systemPrompt, 'loaded-1');
  assert.equal(queryParams.options.permissionMode, 'bypassPermissions');
  assert.equal(queryParams.options.allowDangerouslySkipPermissions, true);
  assert.deepEqual(queryParams.options.settingSources, []);
  assert.deepEqual(queryParams.options.settings, { disableBundledSkills: true });
  assert.equal(queryParams.options.strictMcpConfig, true);
  assert.equal(queryParams.options.includePartialMessages, true);
  assert.deepEqual(queryParams.options.thinking, { type: 'adaptive' });
  assert.equal(queryParams.options.effort, undefined);
  assert.equal(queryParams.options.maxTurns, 3);
  assert.equal(queryParams.options.env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-token');
  assert.equal(queryParams.options.env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(queryParams.options.plugins, [
    { type: 'local', path: path.join(workspace, '.agents'), skipMcpDiscovery: true },
  ]);
  assert.equal(queryParams.options.skills, 'all');
  assert.deepEqual(queryParams.options.tools, [
    'Bash',
    'Read',
    'Skill',
    'TodoWrite',
    'TaskOutput',
    'TaskStop',
  ]);
  assert.deepEqual(queryParams.options.allowedTools, [
    'Bash',
    'Read',
    'TodoWrite',
    'TaskOutput',
    'TaskStop',
    'mcp__sky__sample_tool',
  ]);
  assert.equal(mcpServerCalls.length, 1);
  assert.equal(mcpServerCalls[0].name, 'sky');
  assert.equal(mcpServerCalls[0].tools.length, 1);
  assert.equal(queryParams.options.mcpServers.sky.name, 'sky');

  assert.equal(toolCalls.length, 1);
  const toolResult = await toolCalls[0].handler({ reason: 'reload' }, {});
  assert.deepEqual(toolResult, {
    content: [{ type: 'text', text: 'scheduled:reload' }],
    structuredContent: { accepted: true },
  });
});

test('claude agent sdk session passes configured effort', async () => {
  let queryParams;
  const { deps } = createFakeDeps({
    env: {
      PATH: '/bin',
      HOME: '/tmp/home',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
    },
    query: (params) => {
      queryParams = params;
      return createQuery(async function* () {
        yield initMessage('claude-session-effort');
        yield successResult('claude-session-effort');
      });
    },
  });
  const createSession = createClaudeAgentSdkSessionFactory(deps);
  const session = await createSession({
    key: 'thread-1',
    cwd: '/tmp/workspace',
    agent: {
      name: 'main',
      systemPrompt: 'system',
      model: 'anthropic/claude-opus-4-7',
      effort: 'xhigh',
    },
  });

  await session.prompt('hello');

  assert.deepEqual(queryParams.options.thinking, { type: 'adaptive' });
  assert.equal(queryParams.options.effort, 'xhigh');
});

test('claude agent sdk session freezes the loaded system prompt for the session', async () => {
  const prompts = [];
  const options = [];
  let loaderCalls = 0;
  const { deps } = createFakeDeps({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
    query: (params) =>
      createQuery(async function* () {
        options.push(params.options);
        const input = params.prompt[Symbol.asyncIterator]();
        prompts.push((await input.next()).value.message.content);
        yield initMessage('claude-session-existing');
        yield successResult('claude-session-existing');
        await input.next();
      }),
  });
  const createSession = createClaudeAgentSdkSessionFactory(deps);
  const session = await createSession({
    key: 'thread-1',
    cwd: '/tmp/workspace',
    agent: {
      name: 'main',
      systemPrompt: 'fallback',
      systemPromptLoader: () => `loaded-${++loaderCalls}`,
      model: 'anthropic/claude-sonnet-4-6',
    },
  });

  await session.prompt('one');
  await session.prompt('two');

  assert.deepEqual(prompts, ['one', 'two']);
  assert.equal(loaderCalls, 1);
  assert.equal(session.systemPrompt, 'loaded-1');
  assert.deepEqual(
    options.map((option) => option.resume),
    [undefined, 'claude-session-existing'],
  );
  assert.deepEqual(
    options.map((option) => option.systemPrompt),
    ['loaded-1', 'loaded-1'],
  );
});

test('claude agent sdk session resumes with the stored system prompt snapshot', async () => {
  const prompts = [];
  const options = [];
  let loaderCalls = 0;
  const { deps } = createFakeDeps({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
    query: (params) =>
      createQuery(async function* () {
        options.push(params.options);
        const input = params.prompt[Symbol.asyncIterator]();
        prompts.push((await input.next()).value.message.content);
        yield initMessage('claude-session-existing');
        yield successResult('claude-session-existing');
        await input.next();
      }),
  });
  const createSession = createClaudeAgentSdkSessionFactory(deps);
  const session = await createSession({
    key: 'thread-1',
    cwd: '/tmp/workspace',
    resume: { sessionId: 'claude-session-existing', systemPrompt: 'stored prompt' },
    agent: {
      name: 'main',
      systemPrompt: 'fallback',
      systemPromptLoader: () => `loaded-${++loaderCalls}`,
      model: 'anthropic/claude-sonnet-4-6',
    },
  });

  await session.prompt('one');
  await session.prompt('two');

  assert.deepEqual(prompts, ['one', 'two']);
  assert.equal(loaderCalls, 0);
  assert.equal(session.systemPrompt, 'stored prompt');
  assert.deepEqual(
    options.map((option) => option.resume),
    ['claude-session-existing', 'claude-session-existing'],
  );
  assert.deepEqual(
    options.map((option) => option.systemPrompt),
    ['stored prompt', 'stored prompt'],
  );
});

test('claude agent sdk resumed legacy session falls back without reloading prompt files', async () => {
  let loaderCalls = 0;
  let queryOptions;
  const { deps } = createFakeDeps({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
    query: (params) => {
      queryOptions = params.options;
      return createQuery(async function* () {
        const input = params.prompt[Symbol.asyncIterator]();
        await input.next();
        yield initMessage('claude-session-existing');
        yield successResult('claude-session-existing');
        await input.next();
      });
    },
  });
  const createSession = createClaudeAgentSdkSessionFactory(deps);
  const session = await createSession({
    key: 'thread-1',
    cwd: '/tmp/workspace',
    resume: { sessionId: 'claude-session-existing' },
    agent: {
      name: 'main',
      systemPrompt: 'fallback',
      systemPromptLoader: () => `loaded-${++loaderCalls}`,
      model: 'anthropic/claude-sonnet-4-6',
    },
  });

  await session.prompt('one');

  assert.equal(loaderCalls, 0);
  assert.equal(session.systemPrompt, 'fallback');
  assert.equal(queryOptions.systemPrompt, 'fallback');
});

test('claude agent sdk abort interrupts the active query and swallows the sdk diagnostic quirk', async () => {
  const interrupted = deferred();
  const queryStarted = deferred();
  let interruptCount = 0;
  const { deps } = createFakeDeps({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
    query: (params) =>
      createQuery(
        async function* () {
          const input = params.prompt[Symbol.asyncIterator]();
          await input.next();
          yield initMessage('claude-session-1');
          queryStarted.resolve();
          await interrupted.promise;
          yield errorResult('claude-session-1');
          await input.next();
          throw new Error('[ede_diagnostic] interrupted after input closed');
        },
        {
          interrupt: async () => {
            interruptCount += 1;
            interrupted.resolve();
          },
        },
      ),
  });
  const createSession = createClaudeAgentSdkSessionFactory(deps);
  const session = await createSession({
    key: 'thread-1',
    cwd: '/tmp/workspace',
    agent: {
      name: 'main',
      systemPrompt: 'system',
      model: 'anthropic/claude-opus-4-7',
    },
  });

  const prompt = session.prompt('slow turn');
  await queryStarted.promise;
  await session.abort();
  await prompt;

  assert.equal(interruptCount, 1);
  assert.equal(session.sessionId, 'claude-session-1');
});

test('claude agent sdk dispose closes an active query without starting an async interrupt', async () => {
  const closed = deferred();
  const queryStarted = deferred();
  let closeCount = 0;
  let interruptCount = 0;
  const { deps } = createFakeDeps({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
    query: (params) =>
      createQuery(
        async function* () {
          const input = params.prompt[Symbol.asyncIterator]();
          await input.next();
          yield initMessage('claude-session-1');
          queryStarted.resolve();
          await closed.promise;
          throw new Error('query closed');
        },
        {
          interrupt: async () => {
            interruptCount += 1;
            throw new Error('interrupt should not be called by dispose');
          },
          close: () => {
            closeCount += 1;
            closed.resolve();
          },
        },
      ),
  });
  const createSession = createClaudeAgentSdkSessionFactory(deps);
  const session = await createSession({
    key: 'thread-1',
    cwd: '/tmp/workspace',
    agent: {
      name: 'main',
      systemPrompt: 'system',
      model: 'anthropic/claude-opus-4-7',
    },
  });

  const prompt = session.prompt('slow turn');
  await queryStarted.promise;
  session.dispose();
  await assert.rejects(prompt, /query closed/);

  assert.equal(closeCount, 1);
  assert.equal(interruptCount, 0);
});

test('claude agent sdk rejects non-anthropic model prefixes clearly', async () => {
  const { deps } = createFakeDeps({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
    query: () => {
      throw new Error('query should not be called');
    },
  });
  const createSession = createClaudeAgentSdkSessionFactory(deps);
  const session = await createSession({
    key: 'thread-1',
    cwd: '/tmp/workspace',
    agent: {
      name: 'main',
      systemPrompt: 'system',
      model: 'openai/gpt-5',
    },
  });

  await assert.rejects(() => session.prompt('hello'), /Unsupported Claude Agent SDK model provider/);
});
