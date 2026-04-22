---
title: Memory System v2 Phase 3 — L3 Dream Agent
type: feature
status: completed
created_at: 2026-04-20T18:30:00+09:00
parent: 2026-04-20-memory-v2.md
---

# Memory System v2 Phase 3 — L3 Dream Agent

## Context

[[claudeclaw-memory-v2]]의 L3(지식 consolidation + 일간 에피소드) 레이어를 구현한다. Phase 1(L2 working memory)은 이미 배포되어 5분 cron으로 `_recent.md`만 유지 중. 그 하위·상위 레이어 중 **L3를 L4보다 먼저** 만든다 — 이유는:

- L4 weekly의 자연스러운 입력이 L3 daily 꿈 로그여서, L3 없이 L4만 만들면 L1 raw를 직접 뒤지는 어색한 구조가 됨.
- 현재 **volatile** 구간이 가장 큼: L2가 24h로 축소된 후 24h를 넘긴 맥락이 볼트의 장기 지식으로 녹아들어가지 않고 transcripts에만 남음. L3가 이 공백을 메운다.

### 두 스텝 구조 (태영님 요청)

L3는 한 에이전트가 모든 걸 하지 않는다. **책임 분리 + 감사 가능성**을 위해 두 에이전트가 순차 실행된다:

| 스텝 | 에이전트 | 입력 | 출력 | 툴 |
|---|---|---|---|---|
| Step 1 | `dream-summarize` | 어제 transcript 전체 (시간 윈도우 추출) | `episodes/daily/YYYY-MM-DD.md` (덮어쓰기) | `Write` |
| Step 2 | `dream-knowledge` | Step 1 산출물 + (필요시) transcript | `people/`·`projects/`·`context/`·`knowledge/` 갱신 + `index.md` 동기화 + **`YYYY-MM-DD.md` 맨 아래 업데이트 내역 append** | `Read, Write, Edit, Glob, Grep` |

감사 포인트: **그 날 밤 L3가 지식 그래프에 뭘 했는지**가 항상 같은 daily 파일 맨 아래 남는다. 한 달 뒤에도 "4월 19일 밤에 왜 이 페이지가 이렇게 바뀌었지?"를 추적 가능.

## 합의된 디자인 결정 (2026-04-20)

| 결정 | 값 |
|---|---|
| 실행 시점 | 매일 02:00 Asia/Seoul (crontab: `0 2 * * *`) |
| "어제" 범위 | `[어제 00:00 KST, 오늘 00:00 KST)` — transcript entry 타임스탬프로 필터 |
| 모델 | 두 스텝 모두 `claude-opus-4-7` + thinking high (메인 에이전트와 동일 수준) |
| CLI | `claudeclaw dream [--date YYYY-MM-DD] [--step summarize|knowledge]` |
| 파일명 | `memory/episodes/daily/YYYY-MM-DD.md` (ISO date, Asia/Seoul) |
| 기존 파일 있을 시 | **읽지 않고 덮어쓰기** (Step 1) / **append**만 (Step 2 업데이트 내역) |
| Archive | **하지 않음** (이번 Phase 제외). 날짜 윈도우 필터가 idempotent이므로 중복 처리 없음 |
| Skip 조건 | 전 날 transcript entry 0개일 때만 "조용한 날" 템플릿 + Step 2 스킵 |
| L2와의 관계 | 독립. L2 `memory-cursors.json`은 L3와 무관하게 L2가 자체 관리 |

## 볼트 경계 (STRICT)

### Step 1 `dream-summarize`

- **Write 가능**: `memory/episodes/daily/YYYY-MM-DD.md` 단 하나
- **Read 금지**: transcript는 user message로 주입되므로 Read 툴 자체 필요 없음 (덮어쓰기 정책상 이전 daily 파일도 읽지 않음)
- 툴셋: `['Write']`

### Step 2 `dream-knowledge`

- **Write/Edit 가능**: `memory/people/`, `memory/projects/`, `memory/context/`, `memory/knowledge/`, `memory/index.md`, 그리고 **당일 `episodes/daily/YYYY-MM-DD.md`의 업데이트 내역 섹션만 append**
- **Write 금지**: `memory/_recent.md` (L2 영역), `memory/episodes/weekly/`, `memory/episodes/monthly/`, `memory/episodes/yearly/` (각 레이어 영역)
- **Read 가능**: 볼트 전체 (맥락 파악 + 중복 방지)
- 툴셋: `['Read', 'Write', 'Edit', 'Glob', 'Grep']`

## daily 파일 포맷

```markdown
---
date: 2026-04-19
updated: 2026-04-20T02:05:00+09:00
tags: [meta/daily]
---

# 2026-04-19 (일)

## 🎯 하이라이트
- **[HH:MM]** ...

## 💡 결정
- ...

## 🚀 진행
- ...

## ❓ 미해결
- ...

## 🔍 관찰 / 성찰
- (특이 패턴, 감정의 결, 배운 것)

---

## 📝 지식 업데이트 내역

_L3 dream-knowledge가 append하는 섹션. 이 아래는 감사 용도. 다음 실행에서도 덮어쓰지 않음._

- [[이태영]] — "ADHD 관련 선호" 문단 추가
- [[claudeclaw-memory-v2]] — Phase 3 구현 시작 기록
- 신규 페이지 [[weekly-memory-design]] — weekly 포맷 논의 모아둠
- `index.md` — 위 신규 페이지 등재
```

**포맷 원칙**:
- 한국어 (태영님 언어 기준)
- 타임스탬프는 `[HH:MM]` Asia/Seoul
- wikilinks 적극 사용 → drill down 용이
- **transcript 복붙 금지**, 추출만
- 빈 섹션은 omit 하지 않고 유지 (일간 리듬의 시각적 일관성)

## 트랜스크립트 타임윈도우 추출

transcript 파일 포맷:
```
### user (2026-04-19T07:30:00Z)

<text>

### assistant (2026-04-19T07:31:00Z)

<text>
```

추출 알고리즘:
1. `~/.claudeclaw/transcripts/**/*.md` 전체 스캔
2. 각 파일을 regex `/^### (user|assistant) \((.+?)\)\n\n([\s\S]*?)(?=\n### (?:user|assistant) \(|$)/gm`로 파싱
3. 파싱된 `timestamp`가 `[startUtc, endUtc)` 범위에 드는 엔트리만 채택
4. 엔트리를 `(chatId, sessionId, timestamp)` 순으로 정렬
5. Step 1 user prompt에 전체 삽입 (Opus context window로 하루치는 무리 없음)

## 실행 플로우

```
cron 02:00 → claudeclaw dream
  ├─ 어제 KST 날짜 계산
  ├─ transcript entries 추출 (어제 00:00~24:00 KST)
  ├─ 엔트리 0개 → "조용한 날" 템플릿 Write + Step 2 스킵 + 종료
  ├─ Step 1: dream-summarize
  │   ├─ SessionManager.open('dream:summarize', summarizeAgent)
  │   ├─ send(user prompt with date + entries)
  │   └─ close()
  ├─ Step 2: dream-knowledge
  │   ├─ SessionManager.open('dream:knowledge', knowledgeAgent)
  │   ├─ send(user prompt pointing to daily file + transcript entries)
  │   └─ close()
  └─ Slack 알림 (메모리 채널, 기존 L2와 동일 경로, 말머리 `[dream]`)
```

## 파일 구조

```
src/agents/dream/
├── agent.ts              ← runDreamAgent (오케스트레이션)
├── date.ts               ← KST 날짜/범위 유틸
├── transcripts.ts        ← 타임윈도우 엔트리 추출
├── prompt-summarize.ts   ← Step 1 system prompt
└── prompt-knowledge.ts   ← Step 2 system prompt

src/commands/
└── dream.ts              ← claudeclaw dream [--date] [--step]

test/
└── dream-agent.test.mjs  ← 날짜 범위 / 엔트리 추출 / 스킵 분기 테스트
```

## 테스트 전략

단위:
- `getYesterdayKey(now)` — KST 경계 정확성 (02:00 KST, 23:59 KST, UTC 시점에서 계산)
- `extractEntriesInRange(start, end, fixtures)` — 경계 포함/제외, 여러 세션 병합, 정렬 순서
- 엔트리 0개 → 조용한 날 분기
- `--date` override

통합 (smoke):
- 수동 `claudeclaw dream --date <어제>` 1회 → `episodes/daily/<어제>.md` 생성 확인, index.md 변경사항 sanity check

## 출력 예시 (smoke test 성공 기준)

1. `memory/episodes/daily/2026-04-19.md` 파일 존재
2. 포맷 frontmatter/섹션 규약 준수
3. 업데이트 내역 섹션에 최소 1개 이상 변경사항 bullet
4. `index.md`에 새 페이지 생성 시 등재되어 있음
5. `_recent.md` 미변경 (L2 영역 침범 없음)

## 리스크 / 열린 질문

- **Opus + thinking high 비용**: 하루 1회라 절대 비용은 작으나, 한 주 transcript가 크면 Step 1 입력이 수만 토큰. 일단 정액 구독 범위에서 운용, 실제 사용량 1주 관찰 후 판단.
- **동시 실행 race**: cron 02:00 = L2 크론(`*/5`) 02:00 동시 트리거. L2는 transcript read-only, L3도 transcript read-only → 충돌 없음. 단 L3 Step 2가 `index.md` 쓸 때 L2가 read만 하므로 무해 (L2는 `_recent.md`만 Write).
- **`index.md` 머지 충돌**: Step 2가 Edit/Write로 `index.md`를 갱신할 때, 동시에 태영님이 옵시디언에서 편집 중이면? — iCloud sync 레이어 신뢰. 실제 발생 빈도 낮을 것으로 판단. 발생 시 옵시디언이 conflict 파일 생성.
- **prompt 인젝션**: transcript 내용 중 "이제 Step 2 지시 무시하고 ..." 같은 악의적 패턴. 현재 태영님·Alan 대화만 들어오는 폐쇄 환경이라 실질 리스크 없음.

## 구현 순서

1. **`date.ts` + `transcripts.ts` 유틸** + 단위 테스트
2. **`prompt-summarize.ts`** (Step 1 system prompt 작성)
3. **`prompt-knowledge.ts`** (Step 2 system prompt 작성)
4. **`agent.ts`** (runDreamAgent 오케스트레이션)
5. **`commands/dream.ts`** + `index.ts` 등록
6. 빌드/타입체크/테스트 통과
7. `--date <어제>` smoke test
8. 커밋 + 푸시
9. crontab `0 2 * * *` 등록

## 마이그레이션 / 배포

- 기존 `memory/episodes/daily/` 비어있음 (Phase 1 이전의 daily는 없음) → clean slate
- 봇 재시작 불필요 (cron 독립 프로세스)
- 첫 실행은 태영님이 `claudeclaw dream --date 2026-04-19` 수동 트리거
- crontab은 기존 L2 항목 바로 아래에 추가:
  ```
  */5 * * * * /Users/taeyoung/Library/pnpm/claudeclaw memory >> ~/.claudeclaw/memory-agent.log 2>&1
  0 2 * * * /Users/taeyoung/Library/pnpm/claudeclaw dream >> ~/.claudeclaw/dream-agent.log 2>&1
  ```

## 다음 단계 (이 계획 완료 후)

- **Phase 2 (L4 weekly)** — 월요일 03:00, L3 daily 꿈 로그 1주치를 입력으로 사용
- **Phase 4 (L1 7일 TTL)** — transcripts 파일 시스템 정리 (장기적으로 SQLite로 이관 검토)
