import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export type ClaudeDiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export type ClaudeQueryDiagnosticSink = (
  level: ClaudeDiagnosticLevel,
  event: string,
  fields: Record<string, unknown>,
) => void;

export type ClaudeQueryDiagnostics = {
  sink?: ClaudeQueryDiagnosticSink;
  supervisionMode?: 'launchd' | 'foreground';
  debugStderr?: (data: string) => void;
  clock?: () => number;
  createAttemptId?: () => string;
  schedule?: (delayMs: number, callback: () => void) => () => void;
};

export type ClaudeQueryPurpose = 'conversation_turn' | 'connection_check';

type ClaudeQueryAttempt = {
  queryCreated(): void;
  inputEnqueued(): void;
  sdkMessage(message: { type: string; subtype?: string }): void;
  completed(): void;
  failed(error: unknown): void;
  aborted(): void;
};

const STALL_THRESHOLDS_MS = [5_000, 15_000] as const;

function defaultSchedule(delayMs: number, callback: () => void): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'Error';
}

function environmentFields(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Record<string, string | boolean | null> {
  return {
    cwd,
    shell: env.SHELL ?? null,
    term: env.TERM ?? null,
    lang: env.LANG ?? null,
    lcAll: env.LC_ALL ?? null,
    tmpdir: env.TMPDIR ?? null,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
  };
}

export function startClaudeQueryAttempt(input: {
  diagnostics?: ClaudeQueryDiagnostics;
  purpose: ClaudeQueryPurpose;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ClaudeQueryAttempt {
  const sink = input.diagnostics?.sink;
  if (!sink) {
    return {
      queryCreated() {},
      inputEnqueued() {},
      sdkMessage() {},
      completed() {},
      failed() {},
      aborted() {},
    };
  }

  const clock = input.diagnostics?.clock ?? (() => performance.now());
  const schedule = input.diagnostics?.schedule ?? defaultSchedule;
  const attempt = input.diagnostics?.createAttemptId?.() ?? randomUUID();
  const startedAt = clock();
  const cancellations: Array<() => void> = [];
  let firstMessageSeen = false;
  let terminal = false;

  const record = (
    level: ClaudeDiagnosticLevel,
    event: string,
    fields: Record<string, unknown> = {},
  ) => {
    try {
      sink(level, event, {
        attempt,
        purpose: input.purpose,
        backend: 'claude-agent-sdk',
        supervision: input.diagnostics?.supervisionMode ?? 'unknown',
        elapsedMs: Math.max(0, Math.round(clock() - startedAt)),
        ...fields,
      });
    } catch {
      // Diagnostics must never change query behavior.
    }
  };
  const cancelStallWarnings = () => {
    for (const cancel of cancellations.splice(0)) cancel();
  };
  const finish = (level: ClaudeDiagnosticLevel, event: string, fields = {}) => {
    if (terminal) return;
    terminal = true;
    cancelStallWarnings();
    record(level, event, fields);
  };

  return {
    queryCreated() {
      if (terminal) return;
      record('debug', 'query_created');
      for (const [index, thresholdMs] of STALL_THRESHOLDS_MS.entries()) {
        cancellations.push(
          schedule(thresholdMs, () => {
            if (terminal || firstMessageSeen) return;
            record(index === 0 ? 'warn' : 'error', 'first_message_stalled', {
              thresholdMs,
              ...(index === 0 ? environmentFields(input.cwd, input.env) : {}),
            });
          }),
        );
      }
    },

    inputEnqueued() {
      if (!terminal) record('debug', 'input_enqueued');
    },

    sdkMessage(message) {
      if (terminal) return;
      if (!firstMessageSeen) {
        firstMessageSeen = true;
        cancelStallWarnings();
        record('info', 'first_sdk_message', {
          messageType: message.type,
          messageSubtype: message.subtype ?? null,
        });
      }
      if (message.type === 'system' && message.subtype === 'init') {
        record('info', 'system_init');
      } else if (message.type === 'result') {
        record('info', 'result_received', { resultSubtype: message.subtype ?? null });
      }
    },

    completed() {
      finish('info', 'query_completed');
    },

    failed(error) {
      finish('error', 'query_failed', { errorName: errorName(error) });
    },

    aborted() {
      finish('info', 'query_aborted');
    },
  };
}

export function claudeDebugQueryOptions(
  diagnostics: ClaudeQueryDiagnostics | undefined,
): { debug?: true; stderr?: (data: string) => void } {
  return diagnostics?.debugStderr
    ? { debug: true, stderr: diagnostics.debugStderr }
    : {};
}
