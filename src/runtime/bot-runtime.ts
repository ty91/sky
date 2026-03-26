import type { Settings } from '../settings.js';
import { ClaudeSessionManager } from '../session/manager.js';
import { formatDirectGetMeProbe, type DirectGetMeProbe } from '../telegram/getme-diagnostics.js';
import { TelegramNetworkClient } from '../telegram/network-client.js';
import { TelegramPollingSession } from '../telegram/polling-session.js';
import { toRuntimeErrorInfo } from '../telegram/error-classifier.js';
import type { TelegramHandlers, TelegramLifecycleEvents } from '../telegram/transport.js';
import {
  createInitialHealth,
  type BotLifecycleState,
  type RuntimeErrorInfo,
  type RuntimeHealth,
  type TelegramPhase,
  type TelegramProbeSnapshot,
  writeHealthSnapshot,
} from './health-store.js';
import { computeBackoffMs, isAbortError, sleep } from './retry.js';

export type BotRuntimeOptions = {
  settings: Settings;
  systemPrompt: string;
};

const TELEGRAM_PROBE_TIMEOUT_MS = 8000;

function nowIso(): string {
  return new Date().toISOString();
}

function hasProbe(error: unknown): error is { probe?: Omit<DirectGetMeProbe, 'ok'> | DirectGetMeProbe } {
  return typeof error === 'object' && error !== null && 'probe' in error;
}

function toProbeSnapshot(probe: DirectGetMeProbe | Omit<DirectGetMeProbe, 'ok'>, ok: boolean): TelegramProbeSnapshot {
  return {
    ok,
    at: nowIso(),
    networkFamily: 4,
    durationMs: probe.totalMs,
    statusCode: probe.statusCode,
    dnsMs: probe.dnsMs,
    tcpMs: probe.tcpMs,
    tlsMs: probe.tlsMs,
    ttfbMs: probe.ttfbMs,
    remoteAddress: probe.remoteAddress,
    remoteFamily: probe.remoteFamily,
    username: probe.username,
    userId: probe.userId,
    errorCode: probe.errorCode,
    errorMessage: probe.errorMessage,
  };
}

export class BotRuntime {
  private readonly sessionManager: ClaudeSessionManager;
  private readonly networkClient: TelegramNetworkClient;
  private readonly health: RuntimeHealth = createInitialHealth();
  private readonly stopController = new AbortController();
  private readonly signalHandlers = new Map<NodeJS.Signals, () => void>();
  private stopPromise?: Promise<void>;
  private stopRequested = false;

  constructor(private readonly options: BotRuntimeOptions) {
    this.sessionManager = new ClaudeSessionManager({
      model: options.settings.claude.model,
      workspace: options.settings.workspace,
      systemPrompt: options.systemPrompt,
    });
    this.networkClient = new TelegramNetworkClient({
      botToken: options.settings.telegram.botToken,
      probeTimeoutMs: TELEGRAM_PROBE_TIMEOUT_MS,
    });
    this.flushHealth();
  }

  async start(): Promise<void> {
    this.installSignalHandlers();

    try {
      await this.runLoop();
    } finally {
      await this.finalizeShutdown();
      this.removeSignalHandlers();
    }
  }

  async stop(reason = 'signal'): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    this.stopRequested = true;
    console.log(`[shutdown] stopping runtime (${reason})`);
    this.stopController.abort();
    this.transitionState('stopping', 'stopping', {
      ready: false,
      currentBackoffMs: undefined,
    });

    this.stopPromise = Promise.resolve();
    await this.stopPromise;
  }

  private async runLoop(): Promise<void> {
    let attempt = 0;

    while (!this.stopRequested) {
      attempt += 1;
      let phase: 'initialize' | 'polling' = 'initialize';
      const events = this.createLifecycleEvents();
      const handlers = this.createHandlers();

      events.onProbeStart();
      console.log(`[startup] probing telegram api (attempt ${attempt})`);

      try {
        const probeResult = await this.networkClient.probeGetMe(this.stopController.signal);
        events.onProbeSuccess(probeResult.identity);
        this.recordProbe(probeResult.probe, true);
        console.log(`[startup] telegram probe ok ${formatDirectGetMeProbe(probeResult.probe)}`);
        console.log(`[startup] telegram bot connected as @${probeResult.identity.username}`);

        this.mergeHealth({
          currentAttempt: attempt,
          lastInitSuccessAt: nowIso(),
          botUsername: probeResult.identity.username,
          botUserId: probeResult.identity.id,
          telegramPhase: 'connecting',
          lastError: undefined,
          recoverable: true,
        });

        const session = new TelegramPollingSession({
          botToken: this.options.settings.telegram.botToken,
          identity: probeResult.identity,
          networkClient: this.networkClient,
          handlers,
          events,
        });

        phase = 'polling';
        const result = await session.runUntilStop(this.stopController.signal);
        if (result.kind === 'stopped') {
          return;
        }
        if (result.kind === 'stopped_unexpectedly') {
          throw result.error;
        }
        phase = result.phase;
        throw result.error;
      } catch (error) {
        if (this.stopRequested || isAbortError(error)) {
          return;
        }

        if (phase === 'initialize' && hasProbe(error) && error.probe) {
          this.recordProbe(
            {
              ...error.probe,
              errorCode: error.probe.errorCode,
              errorMessage: error.probe.errorMessage ?? (error instanceof Error ? error.message : String(error)),
            },
            false,
          );
          console.log(`[startup] telegram probe failed ${formatDirectGetMeProbe({ ok: false, ...error.probe })}`);
        }

        const runtimeError = toRuntimeErrorInfo(error, phase);
        const delay = runtimeError.recoverable
          ? runtimeError.retryAfterMs ?? computeBackoffMs(this.health.consecutiveFailures + 1, {
              baseMs: 5000,
              maxMs: 60000,
            })
          : undefined;

        this.mergeHealth({
          currentAttempt: attempt,
          state: runtimeError.recoverable ? 'running' : 'fatal',
          telegramPhase: runtimeError.recoverable ? 'backoff' : 'fatal',
          ready: false,
          recoverable: runtimeError.recoverable,
          consecutiveFailures: this.health.consecutiveFailures + 1,
          currentBackoffMs: delay,
          lastPollingStoppedAt: phase === 'polling' ? nowIso() : this.health.lastPollingStoppedAt,
          lastError: runtimeError,
        });

        console.error(
          `[startup] telegram ${phase} failed on attempt ${attempt} (${runtimeError.kind}): ${runtimeError.message}`,
        );

        if (!runtimeError.recoverable || delay === undefined) {
          return;
        }

        console.log(`[startup] retrying telegram runtime in ${delay}ms`);
        try {
          await sleep(delay, this.stopController.signal);
        } catch (sleepError) {
          if (this.stopRequested || isAbortError(sleepError)) {
            return;
          }
          throw sleepError;
        }
      }
    }
  }

  private createHandlers(): TelegramHandlers {
    return {
      onStartCommand: async (event) => {
        this.sessionManager.prepareFreshSession(String(event.chatId));
        await event.reply(
          '안녕하세요. 이 봇은 채팅방별로 long-lived query 세션을 유지합니다.\n\n' +
            '- 같은 채팅방 메시지는 같은 query에 계속 들어갑니다\n' +
            '- /new 로 세션을 초기화할 수 있습니다\n' +
            '- system prompt는 AGENTS.md, SOUL.md, USER.md, MEMORY.md를 조립해서 사용합니다',
        );
      },
      onNewCommand: async (event) => {
        this.sessionManager.prepareFreshSession(String(event.chatId));
        await event.reply('새 세션으로 초기화했습니다. 이제 새 query로 다시 시작합니다.');
      },
      onTextMessage: async (event) => {
        if (!event.text) {
          await event.reply('빈 메시지는 처리할 수 없습니다.');
          return;
        }

        const typingLoop = event.createTypingLoop();

        try {
          const result = await this.sessionManager.handleText(String(event.chatId), event.text);
          if (result.kind === 'busy') {
            await event.reply('지금 이전 요청을 처리 중입니다. 잠시 후 다시 보내주세요.');
            return;
          }

          const chunks = result.reply.match(/[\s\S]{1,3500}/g) ?? ['(빈 응답)'];
          for (const chunk of chunks) {
            await event.reply(chunk);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await event.reply(`오류가 났습니다: ${message}`);
        } finally {
          await typingLoop.stop();
        }
      },
    };
  }

  private createLifecycleEvents(): TelegramLifecycleEvents {
    return {
      onProbeStart: () => {
        this.mergeHealth({
          state: 'running',
          telegramPhase: 'probing',
          ready: false,
          currentAttempt: this.health.currentAttempt + 1,
          currentBackoffMs: undefined,
        });
      },
      onProbeSuccess: (identity) => {
        this.mergeHealth({
          botUsername: identity.username,
          botUserId: identity.id,
          lastInitSuccessAt: nowIso(),
        });
      },
      onPollingStart: () => {
        this.mergeHealth({
          state: 'running',
          telegramPhase: 'polling',
          ready: true,
          recoverable: true,
          consecutiveFailures: 0,
          currentBackoffMs: undefined,
          lastPollingStartedAt: nowIso(),
          lastError: undefined,
        });
        console.log('[startup] telegram polling is active');
      },
      onPollingStop: () => {
        this.mergeHealth({
          ready: false,
          lastPollingStoppedAt: nowIso(),
        });
      },
      onUpdateReceived: () => {
        this.mergeHealth({ lastUpdateReceivedAt: nowIso() });
      },
      onMiddlewareError: async (error) => {
        const runtimeError = toRuntimeErrorInfo(error, 'middleware');
        this.recordAuxiliaryFailure(runtimeError, false);
        console.error(`[telegram] middleware error (${runtimeError.kind}): ${runtimeError.message}`);
      },
      onOutboundSuccess: () => {
        this.mergeHealth({ lastOutboundSuccessAt: nowIso() });
      },
      onOutboundFailure: (error) => {
        const runtimeError = error as RuntimeErrorInfo;
        this.recordAuxiliaryFailure(runtimeError, true);
      },
    };
  }

  private recordProbe(probe: DirectGetMeProbe | Omit<DirectGetMeProbe, 'ok'>, ok: boolean): void {
    this.mergeHealth({
      lastProbe: toProbeSnapshot(probe, ok),
    });
  }

  private recordAuxiliaryFailure(error: RuntimeErrorInfo, outboundFailure: boolean): void {
    this.mergeHealth({
      lastError: error,
      ...(outboundFailure ? { lastOutboundFailureAt: nowIso() } : {}),
    });
  }

  private transitionState(
    state: BotLifecycleState,
    telegramPhase: TelegramPhase,
    overrides: Partial<RuntimeHealth> = {},
  ): void {
    const now = nowIso();
    this.mergeHealth({
      state,
      telegramPhase,
      lastStateChangedAt: now,
      ...overrides,
    });
  }

  private mergeHealth(patch: Partial<RuntimeHealth>): void {
    Object.assign(this.health, patch, { updatedAt: nowIso() });
    this.flushHealth();
  }

  private flushHealth(): void {
    writeHealthSnapshot(this.health);
  }

  private installSignalHandlers(): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = () => {
        void this.stop(signal.toLowerCase());
      };
      this.signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  private removeSignalHandlers(): void {
    for (const [signal, handler] of this.signalHandlers.entries()) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers.clear();
  }

  private async finalizeShutdown(): Promise<void> {
    if (!this.stopRequested) {
      this.stopRequested = true;
      this.transitionState(this.health.state === 'fatal' ? 'fatal' : 'stopping', 'stopping', {
        ready: false,
        currentBackoffMs: undefined,
      });
    }

    this.sessionManager.closeAll();
    await this.networkClient.close();

    if (this.health.state !== 'fatal') {
      this.transitionState('stopped', 'stopped', {
        ready: false,
        currentBackoffMs: undefined,
        lastPollingStoppedAt: nowIso(),
      });
    }
  }
}
