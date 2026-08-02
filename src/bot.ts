import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { App } from '@slack/bolt';
import { resolveAgentSessionFactory } from './agents/backend/index.js';
import { createMainAgentConfig } from './agents/main.js';
import type { AgentConfig } from './agents/types.js';
import { createConversationManager, type ConversationManager } from './conversation/manager.js';
import { openConversationStore } from './conversation/store.js';
import { openThreadModelStore } from './conversation/thread-model-store.js';
import type { RuntimeController } from './runtime/controller.js';
import { consumePendingRestart, type PendingRestart } from './runtime/pending-restart.js';
import { withTimeout } from './runtime/retry.js';
import { createScheduledJobDispatcher } from './scheduler/dispatcher.js';
import {
  createScheduledJobScheduler,
  type ScheduledJobScheduler,
} from './scheduler/loop.js';
import { openScheduledJobStore } from './scheduler/store.js';
import { startSlackApp, stopSlackApp } from './slack/app.js';
import {
  createSlackFileUploader,
  type SlackFileUploader,
  type SlackUploadV2Client,
} from './slack/files.js';
import { runProactiveAgentTurn } from './slack/proactive-turn.js';
import type { Settings } from './settings.js';

const SLACK_POST_RESTART_SEND_TIMEOUT_MS = 30_000;

export class SlackStartupError extends Error {
  constructor(cause: unknown) {
    super('Slack runtime failed to start.', { cause });
    this.name = 'SlackStartupError';
  }
}

export type BotRuntime = {
  close(): Promise<void>;
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

/**
 * Build the synthetic post-restart user message injected into the session
 * that originally asked for the restart. Rendered as a `<system-reminder>`
 * block — same pattern Claude Code uses for meta guidance — so Sky parses
 * it as an instruction rather than a normal user prompt.
 */
function buildPostRestartNotice(pending: PendingRestart): string {
  const isoNow = new Date().toISOString();
  const reason = pending.reason?.trim() || '태영님 지시';
  return [
    '<system-reminder>',
    `Harness restarted at ${isoNow}. This is a synthetic trigger injected by`,
    'the harness — not a user message.',
    `Reason: ${reason}.`,
    '',
    'If you were in the middle of a task before the restart, continue with it',
    'now. Otherwise, briefly acknowledge you are back and then stop.',
    '</system-reminder>',
  ].join('\n');
}

/**
 * If a pending-restart payload is on disk, re-open the originating session
 * and deliver the post-restart trigger. Any assistant reply streams out via
 * Slack `chat.postMessage` in the original thread.
 *
 * Best-effort: a missing Slack app, absent channel/thread, or LLM error just
 * logs and returns — the new daemon still boots normally.
 */
export async function triggerPostRestartIfPending(
  slackApp: App | undefined,
  conversationManager: ConversationManager,
  mainAgent: AgentConfig,
): Promise<void> {
  const pending = consumePendingRestart();
  if (!pending) return;

  console.log(
    `[post-restart] consuming pending restart for session=${pending.sessionKey} reason=${pending.reason ?? '(none)'}`,
  );

  if (!slackApp || !pending.channelId || !pending.threadTs) {
    console.warn('[post-restart] no slack app or incomplete target — skipping trigger');
    return;
  }

  try {
    const notice = buildPostRestartNotice(pending);

    const result = await runProactiveAgentTurn({
      conversationManager,
      mainAgent,
      sessionKey: pending.sessionKey,
      prompt: notice,
      deliverFinal: async (finalText) => {
        await withTimeout(
          slackApp.client.chat.postMessage({
            channel: pending.channelId,
            thread_ts: pending.threadTs,
            text: finalText,
          }),
          SLACK_POST_RESTART_SEND_TIMEOUT_MS,
          'Slack post-restart message send',
        );
      },
    });

    if (result.kind === 'error') {
      console.error(`[post-restart] session error: ${result.error.message}`);
    } else if (result.kind === 'interrupted') {
      console.log('[post-restart] trigger turn was interrupted');
    } else {
      console.log('[post-restart] trigger delivered');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[post-restart] unexpected error: ${msg}`);
  }
}

export async function startBotRuntime(
  settings: Settings,
  runtimeController: RuntimeController,
): Promise<BotRuntime> {
  const loadPrompt = () => loadSystemPrompt(settings.workspace);
  const initialPrompt = loadPrompt();
  console.log(`[startup] model: ${settings.model}`);
  console.log(`[startup] agent backend: ${settings.agentBackend}`);
  console.log(`[startup] workspace: ${settings.workspace}`);
  const createSession = resolveAgentSessionFactory(settings.agentBackend, {
    claudeCodeOauthToken: settings.claudeAgentSdk?.oauthToken,
  });

  const scheduledJobStore = openScheduledJobStore();
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
    runtimeController,
  });

  const conversationStore = openConversationStore();
  const threadModelStore = openThreadModelStore();

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
      scheduledJobStore.close();
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

    // Fire the post-restart trigger *after* transports are up but *before* we
    // start waiting for shutdown.
    await triggerPostRestartIfPending(slackApp, conversationManager, mainAgent);

    return {
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
