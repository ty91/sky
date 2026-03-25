import type { Settings } from '../settings.js';
import { ClaudeSessionManager } from '../session/manager.js';
import { LongPollingTransport } from '../telegram/long-polling-transport.js';
import { toRuntimeErrorInfo } from '../telegram/error-classifier.js';
import type { TelegramTransport } from '../telegram/transport.js';
import {
  createInitialHealth,
  type BotLifecycleState,
  type RuntimeErrorInfo,
  type RuntimeHealth,
  writeHealthSnapshot,
} from './health-store.js';
import { computeBackoffMs, isAbortError, sleep } from './retry.js';

export type BotRuntimeOptions = {
  settings: Settings;
  systemPrompt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class BotRuntime {
  private readonly sessionManager: ClaudeSessionManager;
  private readonly health: RuntimeHealth = createInitialHealth();
  private readonly stopController = new AbortController();
  private readonly signalHandlers = new Map<NodeJS.Signals, () => void>();
  private activeTransport?: TelegramTransport;
  private stopPromise?: Promise<void>;
  private stopRequested = false;

  constructor(private readonly options: BotRuntimeOptions) {
    this.sessionManager = new ClaudeSessionManager({
      model: options.settings.claude.model,
      workspace: options.settings.workspace,
      systemPrompt: options.systemPrompt,
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
    this.transitionState('stopping', { ready: false, currentBackoffMs: undefined });

    this.stopPromise = (async () => {
      await this.safeStopTransport(this.activeTransport, 'shutdown');
      this.sessionManager.closeAll();
    })();

    await this.stopPromise;
  }

  private async runLoop(): Promise<void> {
    let attempt = 0;

    while (!this.stopRequested) {
      attempt += 1;
      let phase: 'initialize' | 'polling' = 'initialize';
      const transport = this.createTransport();
      this.activeTransport = transport;

      this.transitionState(attempt === 1 ? 'initializing' : 'degraded', {
        ready: false,
        currentBackoffMs: undefined,
      });
      console.log(`[startup] initializing telegram transport (attempt ${attempt})`);

      try {
        const identity = await transport.initialize(this.stopController.signal);
        phase = 'polling';
        this.mergeHealth({
          botUsername: identity.username,
          botUserId: identity.id,
          lastInitSuccessAt: nowIso(),
          lastError: undefined,
          recoverable: true,
        });
        console.log(`[startup] telegram bot connected as @${identity.username}`);

        await transport.startPolling();
        if (this.stopRequested) {
          return;
        }

        throw new Error('Telegram polling stopped unexpectedly');
      } catch (error) {
        if (this.stopRequested || isAbortError(error)) {
          return;
        }

        const runtimeError = toRuntimeErrorInfo(error, phase);
        const delay = runtimeError.retryAfterMs ?? computeBackoffMs(this.health.consecutiveFailures + 1, {
          baseMs: 5000,
          maxMs: 60000,
        });

        this.mergeHealth({
          state: runtimeError.recoverable ? 'degraded' : 'fatal',
          ready: false,
          recoverable: runtimeError.recoverable,
          consecutiveFailures: this.health.consecutiveFailures + 1,
          currentBackoffMs: runtimeError.recoverable ? delay : undefined,
          lastPollingStoppedAt: phase === 'polling' ? nowIso() : this.health.lastPollingStoppedAt,
          lastError: runtimeError,
        });

        console.error(
          `[startup] telegram ${phase} failed on attempt ${attempt} (${runtimeError.kind}): ${runtimeError.message}`,
        );

        if (!runtimeError.recoverable) {
          return;
        }

        console.log(`[startup] retrying telegram transport in ${delay}ms`);
        await sleep(delay, this.stopController.signal);
      } finally {
        await this.safeStopTransport(transport, 'loop cleanup');
        if (this.activeTransport === transport) {
          this.activeTransport = undefined;
        }
      }
    }
  }

  private createTransport(): TelegramTransport {
    return new LongPollingTransport({
      botToken: this.options.settings.telegram.botToken,
      handlers: {
        onStartCommand: async (event) => {
          this.sessionManager.prepareFreshSession(event.chatId);
          await event.reply(
            '안녕하세요. 이 봇은 채팅방별로 long-lived query 세션을 유지합니다.\n\n' +
              '- 같은 채팅방 메시지는 같은 query에 계속 들어갑니다\n' +
              '- /new 로 세션을 초기화할 수 있습니다\n' +
              '- system prompt는 AGENTS.md, SOUL.md, USER.md, MEMORY.md를 조립해서 사용합니다'
          );
        },
        onNewCommand: async (event) => {
          this.sessionManager.prepareFreshSession(event.chatId);
          await event.reply('새 세션으로 초기화했습니다. 이제 새 query로 다시 시작합니다.');
        },
        onTextMessage: async (event) => {
          if (!event.text) {
            await event.reply('빈 메시지는 처리할 수 없습니다.');
            return;
          }

          const typingLoop = event.createTypingLoop();

          try {
            const result = await this.sessionManager.handleText(event.chatId, event.text);
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
        onUpdateReceived: () => {
          this.mergeHealth({ lastUpdateReceivedAt: nowIso() });
        },
        onPollingStarted: () => {
          this.mergeHealth({
            state: 'polling',
            ready: true,
            recoverable: true,
            consecutiveFailures: 0,
            currentBackoffMs: undefined,
            lastPollingStartedAt: nowIso(),
            lastError: undefined,
          });
          console.log('[startup] telegram polling is active');
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
      },
    });
  }

  private async safeStopTransport(transport: TelegramTransport | undefined, reason: string): Promise<void> {
    if (!transport) return;

    try {
      await transport.stop();
    } catch (error) {
      const runtimeError = toRuntimeErrorInfo(error, 'shutdown');
      this.recordAuxiliaryFailure(runtimeError, false);
      console.error(`[shutdown] transport stop failed during ${reason} (${runtimeError.kind}): ${runtimeError.message}`);
    }
  }

  private recordAuxiliaryFailure(error: RuntimeErrorInfo, outboundFailure: boolean): void {
    this.mergeHealth({
      lastError: error,
      ...(outboundFailure ? { lastOutboundFailureAt: nowIso() } : {}),
    });
  }

  private transitionState(state: BotLifecycleState, overrides: Partial<RuntimeHealth> = {}): void {
    const now = nowIso();
    this.mergeHealth({
      state,
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
      this.transitionState(this.health.state === 'fatal' ? 'fatal' : 'stopping', {
        ready: false,
        currentBackoffMs: undefined,
      });
    }

    await this.safeStopTransport(this.activeTransport, 'finalize');
    this.sessionManager.closeAll();

    if (this.health.state !== 'fatal') {
      this.transitionState('stopped', {
        ready: false,
        currentBackoffMs: undefined,
        lastPollingStoppedAt: nowIso(),
      });
    }
  }
}
