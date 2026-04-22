---
title: 메시지 인터럽트 기능
type: feat
status: completed
created_at: 2026-04-09T12:00:00Z
---

# 메시지 인터럽트 기능

## Context

현재 claudeclaw는 Claude Agent SDK 세션이 요청을 처리하는 동안 새 메시지가 오면 `{ kind: 'busy' }`를 반환하고 "지금 이전 요청을 처리 중입니다. 잠시 후 다시 보내주세요."라고 응답한다.

**목표:** 처리 중인 요청이 있을 때 새 메시지가 오면, 이전 요청을 인터럽트하고 새 메시지를 즉시 처리한다.

### 핵심 발견

- Claude Agent SDK의 `Query` 인터페이스에 `interrupt()` 메서드가 존재한다
- `interrupt()`는 현재 turn만 중단하고, Query 자체는 살아 있어 새 메시지를 계속 push할 수 있다
- `close()`와 달리 provider를 재생성할 필요가 없다

### Codex 리뷰 피드백 반영

초기 설계(generation counter + close/recreate 방식)에 대해 OpenAI Codex의 리뷰를 받았고, 다음 문제점이 지적되었다:

1. **높음** — `close()` 후 collect가 정상 종료(`ok`)로 돌아가 인터럽트된 응답이 사용자에게 전송되는 버그
2. **높음** — 동시 도착 메시지(B, C)의 직렬화 불가 (per-key mutex 없음)
3. **높음** — `/new`(close)와 in-flight send의 side effect 경합 (stale persist)
4. **중간** — `close()`는 SDK에서 리소스 종료용. 현재 turn 취소는 `interrupt()`가 올바른 API
5. **중간** — Slack `onMessage` 콜백의 stale partial reply 유출

### Scope

**포함:**
- `ProviderSession`에 `interrupt()` 추가
- SessionManager를 **per-key worker loop + latest-wins** 패턴으로 재구현
- Slack/Telegram 호출자에서 `interrupted` 결과 처리
- `onMessage` 콜백의 turnId 가드
- 기존 테스트 수정 및 인터럽트 테스트 추가

**제외:**
- `interrupt()` / `close()` 타임아웃 처리 (후속 작업)
- UX 개선 (인터럽트 알림 메시지 등)

---

## Architecture

```
사용자 메시지 A ──▶ send("A") ──▶ ┌─────────────────────────────┐
                                   │     SessionManager.send()    │
사용자 메시지 B ──▶ send("B") ──▶ │                               │
                                   │  1. pending이 있으면 교체      │
사용자 메시지 C ──▶ send("C") ──▶ │     (이전 pending → interrupted)│
                                   │  2. activeTurn이 있으면        │
                                   │     provider.interrupt() 호출  │
                                   │  3. worker가 안 돌면 시작      │
                                   └──────────┬──────────────────┘
                                              │
                                              ▼
                                   ┌──────────────────────────────┐
                                   │      Worker Loop (per-key)    │
                                   │                                │
                                   │  while (pending) {             │
                                   │    req = take pending           │
                                   │    turnId = ++counter           │
                                   │    provider.send(req.text)      │
                                   │    provider.collect({           │
                                   │      onMessage: guarded(turnId) │
                                   │    })                           │
                                   │    if interrupted → resolve     │
                                   │       req as 'interrupted'      │
                                   │    else → resolve as 'ok'       │
                                   │  }                              │
                                   └──────────────────────────────┘
```

**Per-key worker loop의 보장:**
- 한 key(채팅방)에서 동시에 **하나의 worker만** provider를 다룸
- 여러 메시지가 동시 도착해도 `pending` 슬롯 하나에 **latest-wins**로 교체
- 이전 pending은 즉시 `{ kind: 'interrupted' }`로 resolve
- active turn의 `onMessage` 콜백에 turnId 가드 → stale partial 전송 차단
- side effect(`onSessionCreated`)도 turnId 가드 → stale persist 방지

---

## Design Decisions

| 질문 | 결정 | 근거 |
|------|------|------|
| turn 취소 방법 | `Query.interrupt()` | SDK가 제공하는 전용 API. `close()`와 달리 Query가 살아 있어 재생성 불필요 |
| 동시성 제어 | per-key worker loop | mutex보다 단순. pending 슬롯 하나로 latest-wins 구현 |
| stale partial 방지 | turnId 가드 in `onMessage` | 인터럽트 후 이전 turn의 콜백이 호출되어도 무시 |
| `SendResult` 변경 | `'busy'` 제거, `'interrupted'` 추가 | busy는 더 이상 발생하지 않음. interrupted는 호출자가 무시해야 하는 결과 |
| provider 재생성 | 불필요 | `interrupt()`는 현재 turn만 중단. 동일 Query에 새 메시지 push 가능 |

---

## Implementation Steps

### Step 1: ProviderSession에 `interrupt()` 추가

**`src/providers/types.ts`**

```typescript
export type ProviderSession = {
  send(text: string): Promise<void>;
  collect(options?: CollectOptions): Promise<ProviderResult>;
  interrupt(): Promise<void>;  // NEW
  close(): Promise<void>;
};
```

**`src/providers/claude.ts`**

`createClaudeSession` 반환 객체에 `interrupt` 추가:

```typescript
async interrupt(): Promise<void> {
  state.pendingPromptUuid = undefined;
  await state.runner.interrupt();
},
```

`interrupt()` 호출 시 `collectResult`의 `runner.next()`가 resolve되며 (result 메시지 또는 done:true), 루프를 빠져나온다. `pendingPromptUuid`를 초기화하여 이후 메시지와 혼동되지 않게 한다.

**Verification:**
- [ ] `pnpm run typecheck` 통과
- [ ] 기존 테스트 통과 (interrupt는 아직 호출되지 않으므로)

---

### Step 2: SessionEntry 및 SendResult 타입 변경

**`src/session/types.ts`**

```typescript
import type { AgentConfig } from '../agents/types.js';
import type { CollectOptions, ProviderFactory, ProviderSession } from '../providers/types.js';

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

export type PendingRequest = {
  text: string;
  collectOptions?: CollectOptions;
  deferred: Deferred<SendResult>;
};

export type SessionEntry = {
  provider: ProviderSession;
  agent: AgentConfig;
  sessionId?: string;
  turnCounter: number;
  activeTurnId?: number;
  activeTurnInterrupted: boolean;
  pending?: PendingRequest;
  workerRunning: boolean;
  closed: boolean;
};

export type SendResult =
  | { kind: 'ok'; text: string }
  | { kind: 'interrupted' }
  | { kind: 'error'; error: Error };

// ... SessionManagerOptions, OpenSessionOptions, SessionManager 는 기존 유지
```

`SessionManager` 타입에는 변경 없음 (send의 반환 타입이 여전히 `Promise<SendResult>`).

**Verification:**
- [ ] `pnpm run typecheck` 통과

---

### Step 3: SessionManager를 worker loop 패턴으로 재구현

**`src/session/manager.ts`**

핵심 변경:

```typescript
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const sessions = new Map<string, SessionEntry>();

  async function runWorker(key: string, entry: SessionEntry): Promise<void> {
    entry.workerRunning = true;

    while (entry.pending && !entry.closed) {
      const req = entry.pending;
      entry.pending = undefined;

      const turnId = ++entry.turnCounter;
      entry.activeTurnId = turnId;
      entry.activeTurnInterrupted = false;

      try {
        await entry.provider.send(req.text);
        const result = await entry.provider.collect({
          onMessage: req.collectOptions?.onMessage
            ? async (msg) => {
                // turnId 가드: stale turn의 콜백 차단
                if (entry.activeTurnId === turnId && !entry.activeTurnInterrupted) {
                  await req.collectOptions!.onMessage!(msg);
                }
              }
            : undefined,
        });

        if (entry.activeTurnInterrupted || entry.activeTurnId !== turnId || entry.closed) {
          req.deferred.resolve({ kind: 'interrupted' });
        } else {
          if (result.sessionId && result.sessionId !== entry.sessionId) {
            entry.sessionId = result.sessionId;
            // stale persist 방지: 아직 맵에 있는지 확인
            if (sessions.get(key) === entry) {
              options.onSessionCreated?.(key, result.sessionId);
            }
          }
          req.deferred.resolve({ kind: 'ok', text: result.text });
        }
      } catch (error) {
        if (entry.activeTurnInterrupted || entry.activeTurnId !== turnId || entry.closed) {
          req.deferred.resolve({ kind: 'interrupted' });
        } else {
          req.deferred.resolve({ kind: 'error', error: toError(error) });
        }
      } finally {
        if (entry.activeTurnId === turnId) {
          entry.activeTurnId = undefined;
        }
      }
    }

    entry.workerRunning = false;
  }

  return {
    open(key, agent, sessionOptions) {
      if (sessions.has(key)) return;

      sessions.set(key, {
        provider: options.providerFactory.create(
          createProviderConfig(agent, options, sessionOptions?.resume),
        ),
        agent,
        sessionId: sessionOptions?.resume,
        turnCounter: 0,
        activeTurnInterrupted: false,
        workerRunning: false,
        closed: false,
      });
    },

    async send(key, text, collectOptions): Promise<SendResult> {
      const entry = sessions.get(key);
      if (!entry) {
        return { kind: 'error', error: new Error(`Session not open for key: ${key}`) };
      }

      const deferred = createDeferred<SendResult>();

      // 이전 pending이 있으면 즉시 interrupted로 resolve (latest-wins)
      if (entry.pending) {
        entry.pending.deferred.resolve({ kind: 'interrupted' });
      }

      entry.pending = { text, collectOptions, deferred };

      // active turn이 있으면 interrupt
      if (entry.activeTurnId !== undefined) {
        entry.activeTurnInterrupted = true;
        await entry.provider.interrupt();
      }

      // worker가 안 돌고 있으면 시작
      if (!entry.workerRunning) {
        runWorker(key, entry);  // fire-and-forget
      }

      return deferred.promise;
    },

    getSessionId(key) {
      return sessions.get(key)?.sessionId;
    },

    async close(key) {
      const entry = sessions.get(key);
      if (!entry) return;

      entry.closed = true;
      sessions.delete(key);

      // pending이 있으면 interrupted로 resolve
      if (entry.pending) {
        entry.pending.deferred.resolve({ kind: 'interrupted' });
        entry.pending = undefined;
      }

      // active turn interrupt
      if (entry.activeTurnId !== undefined) {
        entry.activeTurnInterrupted = true;
        try {
          await entry.provider.interrupt();
        } catch {
          // interrupt 실패해도 close는 진행
        }
      }

      await entry.provider.close();
    },

    async closeAll() {
      const keys = [...sessions.keys()];
      for (const key of keys) {
        await this.close(key);
      }
    },
  };
}
```

**Verification:**
- [ ] `pnpm run typecheck` 통과
- [ ] `pnpm test` — 기존 테스트는 수정 필요 (Step 5)

---

### Step 4: 호출자 수정 (Telegram, Slack)

**`src/runtime/bot-runtime.ts`** — `onTextMessage` 핸들러:

```typescript
// 변경 전
if (result.kind === 'busy') {
  await event.reply('지금 이전 요청을 처리 중입니다. 잠시 후 다시 보내주세요.');
  return;
}

// 변경 후
if (result.kind === 'interrupted') {
  return;  // 조용히 무시
}
```

**`src/slack/assistant.ts`** — `userMessage` 핸들러:

```typescript
// 변경 전
if (result.kind === 'busy') {
  await sender.sendReply('지금 이전 요청을 처리 중입니다. 잠시 후 다시 보내주세요.');
}

// 변경 후
if (result.kind === 'interrupted') {
  // 조용히 무시 — 새 메시지가 이미 처리 중
}
```

**Verification:**
- [ ] `pnpm run typecheck` 통과
- [ ] busy 관련 코드가 남아있지 않은지 확인

---

### Step 5: 테스트 수정 및 추가

**`test/session-manager.test.mjs`**

기존 "reports busy" 테스트를 인터럽트 동작 테스트로 교체:

```javascript
test('session manager interrupts previous request on new message', async () => {
  let collectResolve;
  let interruptCalled = false;

  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    providerFactory: {
      create: () => ({
        send: async () => {},
        collect: async () => {
          // 첫 번째 collect는 interrupt될 때까지 대기
          return new Promise((resolve) => { collectResolve = resolve; });
        },
        interrupt: async () => {
          interruptCalled = true;
          // interrupt 시 pending collect를 resolve
          collectResolve?.({ text: '(interrupted)', sessionId: undefined });
        },
        close: async () => {},
      }),
    },
  });

  manager.open('t1', { name: 'main', systemPrompt: 'system' });

  const first = manager.send('t1', 'hello');
  // collect가 블록된 상태에서 두 번째 메시지
  const second = manager.send('t1', 'world');

  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.kind, 'interrupted');
  assert.equal(interruptCalled, true);
  assert.equal(secondResult.kind, 'ok');
});

test('rapid messages resolve intermediate ones as interrupted', async () => {
  // A 처리 중 B, C 연속 도착 → B는 즉시 interrupted, A는 interrupt 후 interrupted, C만 ok
  // ...
});
```

**`test/slack-assistant.test.mjs`**

기존 "reports busy sessions" 테스트를 `{ kind: 'interrupted' }` 동작으로 수정.

**Verification:**
- [ ] `pnpm test` 전체 통과

---

## File Summary

| File | Action | LOC |
|------|--------|-----|
| `src/providers/types.ts` | Modify | ~2 |
| `src/providers/claude.ts` | Modify | ~5 |
| `src/session/types.ts` | Modify | ~30 |
| `src/session/manager.ts` | Modify | ~80 |
| `src/runtime/bot-runtime.ts` | Modify | ~5 |
| `src/slack/assistant.ts` | Modify | ~5 |
| `test/session-manager.test.mjs` | Modify | ~60 |
| `test/slack-assistant.test.mjs` | Modify | ~10 |

---

## Testing Strategy

| Test File | Coverage |
|-----------|----------|
| `test/session-manager.test.mjs` | 기본 send/collect, 인터럽트, 연속 인터럽트(latest-wins), close 중 인터럽트, missing session |
| `test/slack-assistant.test.mjs` | interrupted 결과 시 무시 동작, 기존 동작 유지 |

수동 테스트:
- Telegram에서 긴 요청 처리 중 새 메시지 전송 → 이전 요청 중단, 새 메시지에 응답
- Slack에서 동일 시나리오 확인
- `/new` 명령어가 인터럽트와 충돌하지 않는지 확인

---

## Edge Cases & 후속 작업

| Edge Case | 현재 대응 | 후속 |
|-----------|----------|------|
| `interrupt()` 타임아웃/hang | 미처리 | 타임아웃 + poisoned entry fallback 추가 |
| `close()` 중 worker 경합 | `entry.closed` 플래그로 가드 | — |
| 이미 전송된 partial reply (Slack) | turnId 가드로 추가 전송 차단 | 이미 나간 메시지 삭제 검토 |
| tool side effect 롤백 | 불가 (SDK 한계) | 사용자 안내 메시지 검토 |
