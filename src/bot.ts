import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { App } from '@slack/bolt';
import { createMainAgentConfig } from './agents/main.js';
import type { AgentConfig } from './agents/types.js';
import { spawnDetachedRestart } from './daemon.js';
import { BotRuntime } from './runtime/bot-runtime.js';
import { consumePendingRestart, type PendingRestart } from './runtime/pending-restart.js';
import { createClaudeProviderFactory } from './providers/claude.js';
import { createSessionManager, type SessionManager } from './session/manager.js';
import { openSessionStore } from './session/store.js';
import { startSlackApp, stopSlackApp } from './slack/app.js';
import { loadSettings } from './settings.js';

/** Delay before we spawn the replacement daemon and exit ourselves. */
const RESTART_DELAY_MS = 3_000;

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

/**
 * Schedule the self-restart. Called by the `restart_harness` tool after it
 * writes the pending-restart payload.
 *
 * We delay a few seconds so the current assistant turn has time to:
 *   1. receive the tool result
 *   2. generate its brief "restarting" reply
 *   3. flush that reply to Slack
 *
 * At `RESTART_DELAY_MS` we spawn the replacement daemon (detached) and send
 * ourselves SIGTERM, which drops into the existing shutdown path
 * (`waitForShutdownSignal` resolves → `finally` block runs → process exits).
 */
function makeRestartScheduler(): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    console.log(`[restart] scheduled in ${RESTART_DELAY_MS}ms`);
    setTimeout(() => {
      try {
        spawnDetachedRestart();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[restart] failed to spawn replacement: ${msg}`);
      }
      console.log('[restart] sending SIGTERM to self');
      process.kill(process.pid, 'SIGTERM');
    }, RESTART_DELAY_MS).unref();
  };
}

/**
 * Build the synthetic post-restart user message injected into the session
 * that originally asked for the restart. Rendered as a `<system-reminder>`
 * block — same pattern Claude Code uses for meta guidance — so Joy parses
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
async function triggerPostRestartIfPending(
  slackApp: App | undefined,
  sessionManager: SessionManager,
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
    sessionManager.open(pending.sessionKey, mainAgent);
    const notice = buildPostRestartNotice(pending);

    const result = await sessionManager.send(pending.sessionKey, notice, {
      onMessage: async (msg) => {
        await slackApp.client.chat.postMessage({
          channel: pending.channelId,
          thread_ts: pending.threadTs,
          text: msg,
        });
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

export async function startBot(): Promise<void> {
  console.log('[startup] loading settings...');
  const settings = loadSettings();
  const loadPrompt = () => loadSystemPrompt(settings.workspace);
  const initialPrompt = loadPrompt();
  console.log(`[startup] model: ${settings.claude.model}`);
  console.log(`[startup] workspace: ${settings.workspace}`);

  const scheduleRestart = makeRestartScheduler();

  // `initialPrompt` is a fallback for legacy resumed sessions that have no
  // stored snapshot. `loadPrompt` runs again on every new session so edits to
  // AGENTS.md / MEMORY.md / SOUL.md / USER.md take effect without a restart.
  const mainAgent = createMainAgentConfig({
    systemPrompt: initialPrompt,
    systemPromptLoader: loadPrompt,
    model: settings.claude.model,
    onRestartRequested: () => scheduleRestart(),
  });

  const sessionStore = openSessionStore();

  const sessionManager = createSessionManager({
    providerFactory: createClaudeProviderFactory({ cwd: settings.workspace }),
    defaultCwd: settings.workspace,
    store: sessionStore,
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

    // Fire the post-restart trigger *after* transports are up but *before* we
    // start waiting for shutdown. Non-blocking on Telegram-only deployments
    // since the trigger short-circuits without a Slack app.
    await triggerPostRestartIfPending(slackApp, sessionManager, mainAgent);

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
    sessionStore.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startBot().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
