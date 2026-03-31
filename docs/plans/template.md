---
title: <계획 제목>
type: feat | fix | refactor
status: active | completed
created_at: <ISO 8601 UTC, e.g. 2026-03-17T04:46:42Z>
---

# <계획 제목>

## Context

현재 상태와 문제점을 설명한다. 왜 이 작업이 필요한지, 기존에 무엇이 되어 있고 무엇이 빠져 있는지를 명확히 한다.

이 계획의 목표와 범위를 한두 문장으로 요약한다.

### Scope

**포함:**
- 이 계획에서 구현할 항목들

**제외:**
- 명시적으로 이 계획에서 다루지 않는 항목들

---

## Architecture

```
레이어 다이어그램 또는 컴포넌트 관계도 (ASCII)
```

---

## Implementation Steps

### Step 0: <준비 단계 제목>

준비 작업 설명 (의존성 추가, 설정 변경, 인프라 수정 등).

**수정 파일:**
- `path/to/file` — 변경 내용 요약

**Verification:**
- [ ] 검증 항목

---

### Step N: <단계 제목>

**`src/path/to/file.ts`** (~LOC)

모듈의 목적과 역할을 설명한다.

- 주요 함수/메서드 시그니처
- 핵심 동작 설명

```typescript
// 주요 타입 또는 인터페이스
type Example = {
  method(): void;
};
```

**참조:** 기존 코드베이스에서 참고할 패턴이 있으면 경로를 명시

**Verification:**
- [ ] 검증 항목 (테스트 명령어, 동작 확인 등)

---

<!-- Step을 필요한 만큼 반복 -->

## File Summary

| File | Action | LOC |
|------|--------|-----|
| `path/to/file` | New / Modify | ~LOC |

---

## Testing Strategy

| Test File | Coverage | LOC |
|-----------|----------|-----|
| `__tests__/path/to/test.ts` | 테스트 범위 설명 | ~LOC |

보충 설명이 필요하면 테이블 아래에 추가한다.
