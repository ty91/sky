import { addReaction, removeReaction, type ReactionsClient } from './reactions.js';

/**
 * Signals to the user that Sky is actively working on their turn.
 *
 * Lifecycle within a single turn:
 *   begin()  -> user sees "thinking" (kept alive via heartbeat)
 *   pause()  -> indicator hidden right before a message is sent
 *   begin()  -> resumed if more messages are coming
 *   end()    -> fully cleared once the turn is done
 */
export interface TurnActivityIndicator {
  /** Show / resume the working indicator (and keep it alive). */
  begin(): Promise<void>;
  /** Hide the indicator just before sending a user-visible message. */
  pause(): Promise<void>;
  /** Fully clear the indicator at the end of the turn. */
  end(): Promise<void>;
}

export type AssistantStatusClient = {
  assistant: {
    threads: {
      setStatus(args: {
        channel_id: string;
        thread_ts: string;
        status: string;
        loading_messages?: string[];
      }): Promise<unknown>;
    };
  };
};

type IntervalHandle = unknown;

export type StatusIndicatorOptions = {
  client: AssistantStatusClient;
  channelId: string;
  threadTs: string;
  /** Text shown after the app name, e.g. "답변 준비 중..." -> "Sky 답변 준비 중...". */
  statusText?: string;
  /** Optional rotating loading messages Slack cycles through. */
  loadingMessages?: string[];
  /** How often to re-send the status so it survives Slack's ~2min timeout. */
  heartbeatMs?: number;
  setIntervalFn?: (handler: () => void, ms: number) => IntervalHandle;
  clearIntervalFn?: (handle: IntervalHandle) => void;
};

export const DEFAULT_STATUS_TEXT = '답변 준비 중...';
// Slack drops the status after ~2 minutes with no update, so refresh well before that.
export const DEFAULT_HEARTBEAT_MS = 45_000;

/**
 * Assistant-thread indicator backed by `assistant.threads.setStatus`.
 * Renders as "{AppName} {statusText}" inside the thread. Requires the
 * `chat:write` (or legacy `assistant:write`) scope and works in DMs and, since
 * the 2026-03 scope change, agent-invoked channel threads.
 */
export function createStatusIndicator(options: StatusIndicatorOptions): TurnActivityIndicator {
  const {
    client,
    channelId,
    threadTs,
    statusText = DEFAULT_STATUS_TEXT,
    loadingMessages,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
  } = options;
  const setIntervalFn =
    options.setIntervalFn ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
  const clearIntervalFn =
    options.clearIntervalFn ?? ((handle: IntervalHandle) => clearInterval(handle as ReturnType<typeof setInterval>));

  let timer: IntervalHandle | undefined;

  async function pushStatus(status: string): Promise<void> {
    try {
      await client.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadTs,
        status,
        ...(status && loadingMessages && loadingMessages.length > 0
          ? { loading_messages: loadingMessages }
          : {}),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[slack] setStatus failed channel=${channelId} thread_ts=${threadTs}: ${msg}`);
    }
  }

  function stopHeartbeat(): void {
    if (timer !== undefined) {
      clearIntervalFn(timer);
      timer = undefined;
    }
  }

  return {
    async begin() {
      stopHeartbeat();
      await pushStatus(statusText);
      timer = setIntervalFn(() => {
        void pushStatus(statusText);
      }, heartbeatMs);
    },
    async pause() {
      stopHeartbeat();
      await pushStatus('');
    },
    async end() {
      stopHeartbeat();
      await pushStatus('');
    },
  };
}

export type ReactionIndicatorOptions = {
  client: ReactionsClient;
  channelId: string;
  messageTs: string;
  name?: string;
};

/**
 * Fallback indicator that toggles an emoji reaction (default `thought_balloon`)
 * on the triggering message. Used where `setStatus` is unavailable.
 */
export function createReactionIndicator(options: ReactionIndicatorOptions): TurnActivityIndicator {
  const { client, channelId, messageTs, name = 'thought_balloon' } = options;
  return {
    async begin() {
      await addReaction(client, channelId, messageTs, name);
    },
    async pause() {
      await removeReaction(client, channelId, messageTs, name);
    },
    async end() {
      await removeReaction(client, channelId, messageTs, name);
    },
  };
}
