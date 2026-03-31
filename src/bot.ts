import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createMainAgentConfig } from './agents/main.js';
import { BotRuntime } from './runtime/bot-runtime.js';
import { createClaudeProviderFactory } from './providers/claude.js';
import {
  createSessionManager,
  persistSession,
} from './session/manager.js';
import { startSlackApp, stopSlackApp } from './slack/app.js';
import { loadSettings } from './settings.js';

function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function loadSystemPrompt(workspace: string): string {
  const promptFiles = ['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md'] as const;
  const loaded: string[] = [];
  const missing: string[] = [];
  const promptParts: string[] = [];

  for (const file of promptFiles) {
    const content = safeRead(path.join(workspace, file));
    if (content) {
      loaded.push(file);
      promptParts.push(content);
    } else {
      missing.push(file);
    }
  }

  console.log(`[startup] prompt files loaded: ${loaded.join(', ') || '(none)'}`);
  if (missing.length > 0) {
    console.log(`[startup] prompt files missing: ${missing.join(', ')}`);
  }

  const combinedPrompt = promptParts.join('\n\n');
  console.log(`[startup] system prompt length: ${combinedPrompt.length} chars`);
  return combinedPrompt;
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const handlers = new Map<NodeJS.Signals, () => void>();

    const cleanup = () => {
      for (const [signal, handler] of handlers.entries()) {
        process.removeListener(signal, handler);
      }
      handlers.clear();
    };

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = () => {
        console.log(`[shutdown] received ${signal.toLowerCase()}`);
        cleanup();
        resolve();
      };

      handlers.set(signal, handler);
      process.once(signal, handler);
    }
  });
}

export async function startBot(): Promise<void> {
  console.log('[startup] loading settings...');
  const settings = loadSettings();
  const systemPrompt = loadSystemPrompt(settings.workspace);
  console.log(`[startup] model: ${settings.claude.model}`);
  console.log(`[startup] workspace: ${settings.workspace}`);

  const mainAgent = createMainAgentConfig(systemPrompt, settings.claude.model);

  const sessionManager = createSessionManager({
    providerFactory: createClaudeProviderFactory({ cwd: settings.workspace }),
    defaultCwd: settings.workspace,
    onSessionCreated: (key, sessionId) => {
      persistSession(key, sessionId);
    },
  });

  let slackApp: Awaited<ReturnType<typeof startSlackApp>> | undefined;

  try {
    if (settings.slack) {
      console.log('[startup] slack config found, starting slack app...');
      slackApp = await startSlackApp({
        botToken: settings.slack.botToken,
        appToken: settings.slack.appToken,
        sessionManager,
        mainAgent,
      });
    } else {
      console.log('[startup] no slack config, skipping slack app');
    }

    if (settings.telegram) {
      console.log('[startup] telegram config found, starting telegram runtime...');
      const telegramRuntime = new BotRuntime({
        settings: {
          ...settings,
          telegram: settings.telegram,
        },
        sessionManager,
        mainAgent,
      });

      await telegramRuntime.start();
      return;
    }

    console.log('[startup] no telegram config, running slack-only mode');
    await waitForShutdownSignal();
  } finally {
    await sessionManager.closeAll();
    if (slackApp) {
      await stopSlackApp(slackApp);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startBot().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
