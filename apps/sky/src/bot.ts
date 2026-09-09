import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveAgentSessionFactory } from './agents/backend/index.js';
import { createMainAgentConfig } from './agents/main.js';
import { createConversationManager, type ConversationManager } from './conversation/manager.js';
import { openConversationStore } from './conversation/store.js';
import { openThreadModelStore } from './conversation/thread-model-store.js';
import type { RuntimeController } from './runtime/controller.js';
import { createRuntimeAdmin, type RuntimeAdmin } from './runtime/admin.js';
import { createScheduledJobDispatcher } from './scheduler/dispatcher.js';
import {
  createScheduledJobScheduler,
  type ScheduledJobScheduler,
} from './scheduler/loop.js';
import { openScheduledJobStore } from './scheduler/store.js';
import type { ScheduledJobStore } from './scheduler/types.js';
import { startSlackApp, stopSlackApp } from './slack/app.js';
import {
  createSlackFileUploader,
  type SlackFileUploader,
  type SlackUploadV2Client,
} from './slack/files.js';
import type { Settings } from './settings.js';
import { createSkyHome, type SkyHome } from './sky-home.js';
import type { ClaudeQueryDiagnostics } from './agents/backend/claude-observability.js';

export class SlackStartupError extends Error {
  constructor(cause: unknown) {
    super('Slack runtime failed to start.', { cause });
    this.name = 'SlackStartupError';
  }
}

export type BotRuntime = {
  admin: RuntimeAdmin;
  close(): Promise<void>;
};

export type BotRuntimeObservability = {
  claudeDiagnostics?: ClaudeQueryDiagnostics;
};

function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

export function loadSystemPrompt(workspace: string): string {
  const promptFiles = ['SOUL.md', 'AGENTS.md', 'USER.md', 'MEMORY.md'] as const;
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

export function createSlackFileUploaderProvider(
  getSlackApp: () => { client: SlackUploadV2Client } | undefined,
): () => SlackFileUploader | undefined {
  return () => {
    const slackApp = getSlackApp();
    return slackApp ? createSlackFileUploader(slackApp.client) : undefined;
  };
}

export async function startBotRuntime(
  settings: Settings,
  runtimeController: RuntimeController,
  skyHome: SkyHome = createSkyHome(),
  sharedScheduledJobStore?: ScheduledJobStore,
  observability: BotRuntimeObservability = {},
): Promise<BotRuntime> {
  const loadPrompt = () => loadSystemPrompt(settings.workspace);
  const initialPrompt = loadPrompt();
  console.log(`[startup] model: ${settings.model}`);
  console.log(`[startup] agent backend: ${settings.agentBackend}`);
  console.log(`[startup] workspace: ${settings.workspace}`);
  const createSession = resolveAgentSessionFactory(settings.agentBackend, {
    claudeCodeOauthToken: settings.claudeAgentSdk?.oauthToken,
    claudeDiagnostics: observability.claudeDiagnostics,
  });

  const scheduledJobStore = sharedScheduledJobStore ?? openScheduledJobStore(skyHome);
  let slackApp: Awaited<ReturnType<typeof startSlackApp>> | undefined;
  let scheduledJobScheduler: ScheduledJobScheduler | undefined;

  // `initialPrompt` is the static fallback for resumed sessions that have no
  // stored snapshot. `loadPrompt` runs again on new sessions so prompt file
  // edits take effect without a restart.
  const mainAgent = createMainAgentConfig({
    systemPrompt: initialPrompt,
    systemPromptLoader: loadPrompt,
    model: settings.model,
    effort: settings.effort,
    slackFileUploaderProvider: createSlackFileUploaderProvider(() => slackApp),
    scheduledJobStore,
  });

  const conversationStore = openConversationStore(skyHome);
  const threadModelStore = openThreadModelStore(skyHome);

  const conversationManager: ConversationManager = createConversationManager({
    defaultCwd: settings.workspace,
    store: conversationStore,
    threadModelStore,
    createSession,
  });

  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= (async () => {
      const schedulerStopped = scheduledJobScheduler?.stop();
      await conversationManager.closeAll();
      await schedulerStopped;
      if (slackApp) {
        await stopSlackApp(slackApp);
      }
      conversationStore.close();
      threadModelStore.close();
      if (!sharedScheduledJobStore) scheduledJobStore.close();
    })();
    return closePromise;
  };

  try {
    console.log('[startup] starting slack app...');
    try {
      slackApp = await startSlackApp({
        botToken: settings.slack.botToken,
        appToken: settings.slack.appToken,
        conversationManager,
        mainAgent,
        threadModelStore,
        runtimeController,
        skyHome,
      });
    } catch (error) {
      throw new SlackStartupError(error);
    }

    const scheduledJobDispatcher = createScheduledJobDispatcher({
      conversationManager,
      mainAgent,
      postMessage: (message) => slackApp!.client.chat.postMessage(message),
    });
    scheduledJobScheduler = createScheduledJobScheduler({
      store: scheduledJobStore,
      dispatcher: scheduledJobDispatcher,
      runtimeController,
    });
    await scheduledJobScheduler.start();

    return {
      admin: createRuntimeAdmin(conversationManager, scheduledJobStore),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
