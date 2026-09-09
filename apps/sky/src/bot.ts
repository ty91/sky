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
import { startSlackApp, stopSlackApp, type SlackSdk } from './slack/app.js';
import { createSlackAgentConfig } from './slack/agent.js';
import type { AgentSessionFactory } from './agents/backend/types.js';
import type { ConversationTurnOptions, ConversationTurnResult } from './conversation/types.js';
import type { DaemonStatus } from './skyd/types.js';
import { computeBackoffMs, sleep, type BackoffOptions } from './runtime/retry.js';
import { createSlackFileUploaderProvider } from './slack/files.js';
import type { Settings } from './settings.js';
import { createSkyHome, type SkyHome } from './sky-home.js';
import type { ClaudeQueryDiagnostics } from './agents/backend/claude-observability.js';

export type BotRuntime = {
  admin: RuntimeAdmin;
  runTurn(key: string, text: string, options?: ConversationTurnOptions): Promise<ConversationTurnResult>;
  close(): Promise<void>;
};

export type BotRuntimeOptions = {
  claudeDiagnostics?: ClaudeQueryDiagnostics;
  createSession?: AgentSessionFactory;
  slackSdk?: SlackSdk;
  backoff?: BackoffOptions;
  random?: () => number;
  onSlackStatus?: (status: DaemonStatus['slack']) => void;
  onSlackError?: (error: unknown) => void;
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

export async function startBotRuntime(
  settings: Settings,
  runtimeController: RuntimeController,
  skyHome: SkyHome = createSkyHome(),
  sharedScheduledJobStore?: ScheduledJobStore,
  runtimeOptions: BotRuntimeOptions = {},
): Promise<BotRuntime> {
  const loadPrompt = () => loadSystemPrompt(settings.workspace);
  const initialPrompt = loadPrompt();
  console.log(`[startup] model: ${settings.model}`);
  console.log(`[startup] agent backend: ${settings.agentBackend}`);
  console.log(`[startup] workspace: ${settings.workspace}`);
  const createSession = runtimeOptions.createSession ?? resolveAgentSessionFactory(settings.agentBackend, {
    claudeCodeOauthToken: settings.claudeAgentSdk?.oauthToken,
    claudeDiagnostics: runtimeOptions.claudeDiagnostics,
  });

  const scheduledJobStore = sharedScheduledJobStore ?? openScheduledJobStore(skyHome);
  let slackApp: Awaited<ReturnType<typeof startSlackApp>> | undefined;
  let scheduledJobScheduler: ScheduledJobScheduler | undefined;

  const agentOptions = {
    systemPrompt: initialPrompt,
    systemPromptLoader: loadPrompt,
    model: settings.model,
    effort: settings.effort,
  };
  const mainAgent = createMainAgentConfig(agentOptions);
  const slackAgent = createSlackAgentConfig({
    ...agentOptions,
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

  const slackAbort = new AbortController();
  const signal = AbortSignal.any([slackAbort.signal, runtimeController.drainingSignal]);
  let slackStatus: DaemonStatus['slack'] = { state: 'not_configured', attempts: 0, nextRetryAt: null };
  const publishSlack = (patch: Partial<DaemonStatus['slack']>) => {
    slackStatus = { ...slackStatus, ...patch };
    runtimeOptions.onSlackStatus?.(slackStatus);
  };
  const slackTask = (async () => {
    if (!settings.slack.botToken || !settings.slack.appToken) {
      publishSlack({ state: 'not_configured' });
      return;
    }
    while (!signal.aborted) {
      publishSlack({ state: slackStatus.attempts ? 'retrying' : 'connecting', nextRetryAt: null });
      let disconnected!: () => void;
      const connectionEnded = new Promise<void>((resolve) => { disconnected = resolve; });
      signal.addEventListener('abort', disconnected, { once: true });
      try {
        slackApp = await startSlackApp({
          botToken: settings.slack.botToken,
          appToken: settings.slack.appToken,
          conversationManager,
          mainAgent: slackAgent,
          threadModelStore,
          runtimeController,
          skyHome,
          sdk: runtimeOptions.slackSdk,
          signal,
          onConnectionState: (state) => {
            publishSlack({ state, nextRetryAt: null });
            if (state === 'retrying') disconnected();
          },
        });
        if (!scheduledJobScheduler) {
          const dispatcher = createScheduledJobDispatcher({
            conversationManager,
            mainAgent: slackAgent,
            postMessage: (message) => slackApp!.client.chat.postMessage(message),
          });
          scheduledJobScheduler = createScheduledJobScheduler({ store: scheduledJobStore, dispatcher, runtimeController });
          await scheduledJobScheduler.start();
        }
        if (!signal.aborted) await connectionEnded;
        if (signal.aborted) return;
        throw new Error('Slack connection was closed.');
      } catch (error) {
        if (signal.aborted) return;
        if (slackApp) await stopSlackApp(slackApp);
        slackApp = undefined;
        const attempts = slackStatus.attempts + 1;
        const delay = computeBackoffMs(attempts, runtimeOptions.backoff, runtimeOptions.random);
        publishSlack({ state: 'retrying', attempts, nextRetryAt: new Date(Date.now() + delay).toISOString() });
        runtimeOptions.onSlackError?.(error);
        try { await sleep(delay, signal); } catch { return; }
      } finally {
        signal.removeEventListener('abort', disconnected);
      }
    }
  })();
  void slackTask.catch((error) => {
    runtimeOptions.onSlackError?.(error);
    publishSlack({ state: 'stopped', nextRetryAt: null });
  });
  let closePromise: Promise<void> | undefined;
  return {
    admin: createRuntimeAdmin(conversationManager, scheduledJobStore),
    async runTurn(key, text, options) {
      const lease = runtimeController.lease('agent_turn');
      if (!lease) return { kind: 'interrupted' };
      try {
        return await conversationManager.runTurn(key, mainAgent, text, options);
      } finally {
        lease.release();
      }
    },
    close() {
      closePromise ??= (async () => {
        slackAbort.abort();
        await slackTask.catch(() => undefined);
        const schedulerStopped = scheduledJobScheduler?.stop();
        await conversationManager.closeAll();
        await schedulerStopped;
        if (slackApp) await stopSlackApp(slackApp);
        conversationStore.close();
        threadModelStore.close();
        if (!sharedScheduledJobStore) scheduledJobStore.close();
      })();
      return closePromise;
    },
  };
}
