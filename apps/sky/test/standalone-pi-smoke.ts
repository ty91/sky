import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createPiSessionFactoryWithDeps } from '../src/agents/backend/pi.js';

const authPath = path.join(process.cwd(), 'auth.json');
await writeFile(authPath, JSON.stringify({
  'openai-codex': {
    type: 'oauth',
    access: 'standalone-synthetic-access',
    refresh: 'standalone-synthetic-refresh',
    expires: Date.now() + 60_000,
  },
}), { mode: 0o600 });
const modelRuntime = await ModelRuntime.create({
  authPath,
  modelsPath: path.join(process.cwd(), 'models.json'),
});
assert.equal((await modelRuntime.getAuth('openai-codex'))?.auth.apiKey, 'standalone-synthetic-access');

const listeners = new Set<(event: unknown) => void>();

const createSession = createPiSessionFactoryWithDeps({
  createAgentSession: async () => ({
    session: {
      sessionId: 'standalone-pi-smoke',
      async prompt(text: string) {
        assert.equal(text, 'standalone pi turn');
        for (const listener of listeners) {
          listener({
            type: 'agent_end',
            willRetry: false,
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'text', text: 'standalone-pi-ok' }],
              },
            ],
          });
        }
      },
      async abort() {},
      dispose() {},
      subscribe(listener: (event: unknown) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  }),
  DefaultResourceLoader: class {
    async reload() {}
  },
  getAgentDir: () => '/tmp/standalone-pi-agent',
  ModelRuntime: {
    create: async () => ({
      getModel: () => undefined,
    }),
  },
  SessionManager: {
    create: () => ({}),
    open: () => ({}),
  },
});

const session = await createSession({
  key: 'standalone-pi-smoke',
  cwd: process.cwd(),
  agent: {
    name: 'standalone-pi-smoke',
    systemPrompt: 'Exercise the standalone Pi session adapter.',
    tools: [],
  },
});
const events: unknown[] = [];
const unsubscribe = session.subscribe((event) => events.push(event));

try {
  await session.prompt('standalone pi turn');
  assert.deepEqual(events, [{ type: 'turn_end', text: 'standalone-pi-ok' }]);
  console.log('STANDALONE_PI_TURN=ok');
} finally {
  unsubscribe();
  session.dispose();
}
