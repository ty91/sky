---
title: Agent Layer 도입
type: refactor
status: active
created_at: 2026-03-31T05:30:00Z
---

# Agent Layer 도입

## Context

현재 claudeclaw는 Claude Agent SDK의 `query()` 호출과 메시지 파싱 루프가 두 곳에 중복되어 있다:
- `src/session/manager.ts`의 `runTurn()` (~90줄) — 메인 대화용
- `src/agents/memory/agent.ts`의 `runMemoryAgent()` (~70줄) — 메모리 에이전트용

새 에이전트를 추가하려면 이 루프를 복사해야 하고, 에이전트 설정(모델, 도구, 프롬프트)이 코드에 하드코딩되어 있어 선언적으로 에이전트를 정의할 수 없다.

**목표:** AgentConfig → ProviderSession → SessionManager 레이어를 도입하여, 임의의 에이전트를 선언적으로 정의하고 동일한 인터페이스로 실행할 수 있는 구조를 만든다.

### Scope

**포함:**
- Provider 레이어 (ProviderSession, ProviderFactory) — Claude SDK 호출 추상화
- AgentConfig 타입 정의
- 키 기반 멀티세션 SessionManager
- 기존 메인 세션 마이그레이션
- 기존 메모리 에이전트 마이그레이션

**제외:**
- WorkflowEngine (Phase 기반 오케스트레이션)
- subAgents 지원
- Intellectual Dive 기능 구현 (별도 계획)

---

## Architecture

```
AgentConfig                  ← 에이전트를 데이터로 정의 (이름, 프롬프트, 도구, 모델)
    │
    ▼
ProviderFactory              ← AgentConfig → ProviderSession 생성
    │
    ▼
ProviderSession              ← send(text) → collect(opts?) → close()
    │                           Claude SDK query 루프가 여기에 한 번만 존재
    ▼
SessionManager               ← 키 기반 멀티세션 관리 (open / send / close)
    │                           onSessionCreated 훅으로 persist 처리
    ▼
Slack / Telegram transport   ← 기존 트랜스포트, 인터페이스만 변경
```

---

## Design Decisions

| 질문 | 결정 | 근거 |
|------|------|------|
| 스트리밍 중간 응답 | `collect()`에 `onMessage` 콜백 옵션 | 메인 대화만 필요, one-shot 에이전트는 콜백 없이 호출하면 됨 |
| 세션 resume/persist | `onSessionCreated` 훅을 SessionManager에 주입 | 선언적이고, resume 필요한 에이전트가 늘어나도 호출 쪽 코드 불변 |
| 에이전트별 cwd 기본값 | `AgentConfig.cwd` 없으면 `settings.workspace` 사용 | 데몬 환경에서 `process.cwd()`는 의미 없음 |

---

## Implementation Steps

### Step 1: Pushable 클래스 분리

현재 `src/session/manager.ts`에 인라인으로 들어 있는 `Pushable<T>` 클래스를 별도 파일로 분리한다. Provider 레이어에서 재사용하기 위함.

**`src/session/pushable.ts`** (~50 LOC)

```typescript
export class Pushable<T> implements AsyncIterable<T> {
  push(value: T): void;
  end(): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}
```

**참조:** `slack-code-team/src/session/pushable.ts`에 동일한 분리가 되어 있음

**수정 파일:**
- `src/session/pushable.ts` — 신규, Pushable 클래스
- `src/session/manager.ts` — Pushable 클래스 제거, import로 대체

**Verification:**
- [x] `pnpm typecheck` 통과
- [x] 기존 동작에 영향 없음 (Pushable 로직 변경 없이 이동만)

---

### Step 2: Provider 타입 정의

**`src/providers/types.ts`** (~30 LOC)

Provider 레이어의 핵심 타입을 정의한다.

```typescript
export type ProviderConfig = {
  systemPrompt: string;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  cwd?: string;
};

export type ProviderResult = {
  text: string;
  sessionId?: string;
};

export type CollectOptions = {
  onMessage?: (text: string) => Promise<void>;
};

export type ProviderSession = {
  send(text: string): Promise<void>;
  collect(options?: CollectOptions): Promise<ProviderResult>;
  close(): Promise<void>;
};

export type ProviderFactory = {
  create(config: ProviderConfig): ProviderSession;
};
```

**참조:** `slack-code-team/src/providers/types.ts` — `CollectOptions`와 `kind` 필드 제외 외 동일 구조

**Verification:**
- [x] `pnpm typecheck` 통과

---

### Step 3: Claude Provider 구현

**`src/providers/claude.ts`** (~120 LOC)

Claude Agent SDK의 `query()` 호출, 메시지 루프, 결과 파싱을 한 곳에 통합한다. 현재 `session/manager.ts`의 `runTurn()`과 `memory/agent.ts`의 `runMemoryAgent()`에 중복된 로직이 여기로 모인다.

```typescript
export function createClaudeProviderFactory(defaults: {
  cwd: string;
}): ProviderFactory;
```

내부 구현:
- `createClaudeSession(config)` — `Pushable` + `query()` 생성, `ProviderSession` 반환
- `buildOptions(config, defaults)` — `Options` 객체 조립. `replay-user-messages`, `permissionMode: 'bypassPermissions'`, `settingSources: []` 등 claudeclaw 고유 설정 포함
- `collectResult(runner, state, options?)` — while 루프로 메시지 수집. `isSystemInitMessage`, `isPromptReplay`, assistant 텍스트 추출, result 처리. `options.onMessage`가 있으면 assistant 메시지마다 호출

**참조:**
- `slack-code-team/src/providers/claude.ts` — 전체 구조
- `src/session/manager.ts` `runTurn()` — `onMessage` 콜백, transcript 연동 패턴
- `src/agents/memory/agent.ts` — one-shot 패턴

**Verification:**
- [x] `pnpm typecheck` 통과

---

### Step 4: AgentConfig 타입 정의

**`src/agents/types.ts`** (~15 LOC)

에이전트를 선언적으로 정의하기 위한 타입.

```typescript
export type AgentConfig = {
  name: string;
  description?: string;
  systemPrompt: string;
  model?: string;        // 기본값: 'sonnet'
  tools?: string[];
  maxTurns?: number;
  cwd?: string;
};
```

**참조:** `slack-code-team/src/agents/types.ts` — `provider`, `subAgents` 필드 제외

**Verification:**
- [x] `pnpm typecheck` 통과

---

### Step 5: SessionManager 리팩터링

**`src/session/manager.ts`** (~80 LOC)
**`src/session/types.ts`** (~20 LOC)

기존 `ClaudeSessionManager`를 키 기반 멀티세션 매니저로 재작성한다.

**`src/session/types.ts`:**
```typescript
export type SessionEntry = {
  provider: ProviderSession;
  busy: boolean;
  sessionId?: string;
};

export type SendResult =
  | { kind: 'ok'; text: string }
  | { kind: 'busy' }
  | { kind: 'error'; error: Error };

export type SessionManagerOptions = {
  providerFactory: ProviderFactory;
  defaultCwd: string;
  onSessionCreated?: (key: string, sessionId: string) => void;
};
```

**`src/session/manager.ts`:**
```typescript
export function createSessionManager(options: SessionManagerOptions) {
  return {
    open(key: string, agent: AgentConfig, opts?: { resume?: string }): void;
    send(key: string, text: string, opts?: CollectOptions): Promise<SendResult>;
    getSessionId(key: string): string | undefined;
    close(key: string): Promise<void>;
    closeAll(): Promise<void>;
  };
}
```

- `open()` — `ProviderFactory.create()`로 세션 생성, resume 옵션은 `ProviderConfig`에 전달
- `send()` — busy 체크 후 `session.send()` + `session.collect()`, 성공 시 `onSessionCreated` 훅 호출
- `close()` / `closeAll()` — 세션 정리

**참조:** `slack-code-team/src/session/manager.ts` — open/send/close 패턴 동일

**Verification:**
- [x] `pnpm typecheck` 통과

---

### Step 6: 메인 대화 마이그레이션

기존 메인 대화 흐름을 새 Agent Layer 위에서 동작하도록 변경한다.

**`src/agents/main.ts`** (~30 LOC, 신규)

메인 대화 에이전트의 AgentConfig를 생성하는 함수.

```typescript
export function createMainAgentConfig(systemPrompt: string): AgentConfig {
  return {
    name: 'main',
    systemPrompt,
    model: 'sonnet',
    tools: ['Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write',
            'Skill', 'TaskOutput', 'TaskStop', 'TodoWrite',
            'WebFetch', 'WebSearch'],
  };
}
```

**수정 파일:**
- `src/bot.ts` — `ClaudeSessionManager` 대신 `createSessionManager()` + `createClaudeProviderFactory()` 사용. 시스템 프롬프트 로딩 후 `createMainAgentConfig()` 호출. `onSessionCreated` 훅에 기존 `persistSession()` 로직 연결
- `src/slack/assistant.ts` — `sessionManager.handleText(threadId, text, onMessage)` 호출을 `sm.open(threadId, mainAgent, { resume }) → sm.send(threadId, text, { onMessage })` 패턴으로 변경. 세션 persist 로딩은 `open()` 호출 전에 처리
- `src/telegram/` 관련 파일 — Slack과 동일한 패턴으로 변경

**주의사항:**
- `TranscriptWriter` 연동: `onMessage` 콜백 안에서 transcript 기록을 함께 처리하거나, 별도 래퍼로 처리
- 세션 persist/resume: 기존 `sessions.json` 로직 유지, `onSessionCreated` 훅과 `open({ resume })` 으로 연결
- `prepareFreshSession()` (Telegram `/new`) → `sm.close(key)` 후 다음 메시지에서 자동 open

**Verification:**
- [x] `pnpm typecheck` 통과
- [x] `pnpm build` 통과
- [x] Slack 새 스레드 메시지 핸들러 스모크 검증 통과
- [x] Slack 기존 스레드 이어쓰기 핸들러 스모크 검증 통과
- [x] 세션 resume 경로 스모크 검증 통과
- [x] Telegram 대화 핸들러 및 런타임 기동 스모크 검증 통과

---

### Step 7: 메모리 에이전트 마이그레이션

기존 메모리 에이전트의 자체 query 루프를 제거하고 SessionManager를 활용하도록 변경한다.

**수정 파일:**
- `src/agents/memory/agent.ts` — 자체 `query()` 호출과 while 루프 제거. `SessionManager`를 인자로 받아 `open → send → close` 패턴 사용. 커서 관리 로직(`advanceCursors`)은 그대로 유지

```typescript
export async function runMemoryAgent(options: {
  sessionManager: ReturnType<typeof createSessionManager>;
  workspace: string;
}): Promise<MemoryAgentResult>;
```

내부:
- `memoryAgent: AgentConfig` 정의 (기존 `MEMORY_AGENT_MODEL`, `MEMORY_AGENT_TOOLS`, `MEMORY_AGENT_SYSTEM_PROMPT` 활용)
- `sm.open('memory:run', memoryAgent)` → `sm.send('memory:run', userPrompt)` → `sm.close('memory:run')`

**참조:** 기존 `src/agents/memory/agent.ts`의 `buildUserPrompt()`, `advanceCursors()` 로직은 변경 없음

**Verification:**
- [x] `pnpm typecheck` 통과
- [x] 메모리 에이전트 실행 경로 스모크 검증 통과
- [x] 트랜스크립트 처리 후 커서 전진 스모크 검증 통과

---

### Step 8: 정리

**수정 파일:**
- 사용하지 않는 코드 제거 (기존 `ClaudeSessionManager` 클래스, 인라인 `Pushable`, 중복 헬퍼 함수 등)
- import 경로 정리

**Verification:**
- [ ] `pnpm typecheck` 통과
- [ ] `pnpm build` 통과
- [ ] `pnpm test` 통과
- [ ] Slack 수동 검증 — 새 스레드, 이어서 대화, 재기동 resume
- [ ] `claudeclaw memory` 수동 검증

---

## File Summary

| File | Action | LOC |
|------|--------|-----|
| `src/session/pushable.ts` | New | ~50 |
| `src/providers/types.ts` | New | ~30 |
| `src/providers/claude.ts` | New | ~120 |
| `src/agents/types.ts` | New | ~15 |
| `src/agents/main.ts` | New | ~30 |
| `src/session/types.ts` | New | ~20 |
| `src/session/manager.ts` | Rewrite | ~80 |
| `src/bot.ts` | Modify | ~120 |
| `src/slack/assistant.ts` | Modify | ~100 |
| `src/agents/memory/agent.ts` | Modify | ~140 |
| `src/telegram/` 관련 | Modify | - |

---

## Testing Strategy

| Test | Coverage | Note |
|------|----------|------|
| `pnpm typecheck` | 타입 안전성 | 모든 Step에서 실행 |
| `pnpm build` | 빌드 성공 | Step 6 이후 |
| `pnpm test` | 기존 테스트 회귀 | Step 8 |
| Slack 수동 검증 | 새 스레드, 이어서 대화, resume | Step 6 이후 |
| `claudeclaw memory` | 메모리 에이전트 동작 | Step 7 이후 |

기존 테스트(`test/*.test.mjs`)가 있으면 회귀 확인에 활용한다. Provider 레이어에 대한 단위 테스트는 이 계획의 범위에서는 수동 검증으로 대체하고, 필요 시 후속으로 추가한다.

## Progress Log

- 2026-03-31: Step 1 완료 — `Pushable`을 `src/session/pushable.ts`로 분리하고 `pnpm typecheck`로 검증함.
- 2026-03-31: Step 2 완료 — `src/providers/types.ts`에 Provider 레이어 타입을 추가하고 `pnpm typecheck`로 검증함.
- 2026-03-31: Step 3 완료 — `src/providers/claude.ts`에 Claude Provider를 구현하고 `pnpm typecheck`로 검증함.
- 2026-03-31: Step 4 완료 — `src/agents/types.ts`에 `AgentConfig`를 추가하고 `pnpm typecheck`로 검증함.
- 2026-03-31: Step 5 완료 — `src/session/types.ts`와 새 `SessionManager`를 추가하고 호환 래퍼를 유지한 채 `pnpm typecheck`로 검증함.
- 2026-03-31: Step 6 완료 — 메인 대화 흐름을 새 Agent Layer로 마이그레이션하고 `pnpm typecheck`, `pnpm build`, Slack/Telegram 스모크 검증으로 확인함.
- 2026-03-31: Step 7 완료 — 메모리 에이전트를 `SessionManager` 기반으로 마이그레이션하고 커서 전진 스모크 검증으로 확인함.
