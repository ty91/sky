---
title: Remove Slack Assistant Status
type: refactor
status: completed
created_at: 2026-05-04T12:59:54Z
---

# Remove Slack Assistant Status

## Context

After the recent ACP provider changes, Sky can finish a GPT-5.5 turn and add
the completion reaction, but Slack can still show the Assistant status text such
as "응답을 생성 중..." after the final reply. The current Slack handler sends a
reply and then immediately sets `생각 중...` again, relying on the final clear
call to remove it. That is fragile, and Sky already has explicit reaction-based
turn state.

This plan removes Sky-owned Slack Assistant status usage entirely. Progress
state is represented by reactions only. Model-generated message text such as
"검색해보겠습니다" is not changed.

### Scope

**포함:**
- Remove every `setStatus` call from the Slack Assistant user-message flow.
- Remove `SlackSender` status support so it only sends Slack replies with retry.
- Remove stale Slack transport status type surface if it is unused.
- Update Slack tests to assert reply and reaction behavior without status calls.

**제외:**
- Changing model prompts or suppressing model-authored progress language.
- Implementing Slack `chat.startStream`, `chat.appendStream`, or
  `chat.stopStream`.
- Changing daemon `sky status` CLI behavior.

---

## Architecture

```text
Slack user message
      |
      v
src/slack/assistant.ts
      | add :thought_balloon:
      v
SessionManager.send(... onMessage ...)
      |
      v
SlackSender.sendReply(msg)
      |
      v
success -> add :white_check_mark:
interrupt -> add :hand:
finally -> remove :thought_balloon:
```

`src/slack/assistant.ts` remains responsible for turn lifecycle and reactions.
`src/slack/sender.ts` remains responsible for Slack reply chunking and retry.
No component should call Slack Assistant thread status APIs.

---

## Implementation Steps

### Step 0: Remove Status From The Slack Turn Flow

Delete status handling from the assistant user-message path while preserving
reply, transcript, interruption, error, and reaction behavior.

**수정 파일:**
- `src/slack/assistant.ts` — remove `setStatus` destructuring from
  `userMessage`, construct `SlackSender` with only `say`, and delete all
  `sender.setStatus(...)` calls.

**참조:**
- `src/slack/assistant.ts` — reuse existing `addReaction()` and
  `removeReaction()` helpers.
- `src/session/manager.ts` — keep existing `onMessage` and result-kind flow.

**Verification:**
- [x] `rg "setStatus|생각 중" src/slack/assistant.ts`

---

### Step 1: Simplify `SlackSender`

Remove status support from `SlackSender` so the class has one responsibility:
posting Slack replies with chunking and retry.

**수정 파일:**
- `src/slack/sender.ts` — remove `SlackSenderOptions.setStatus` and the
  `setStatus()` method.

**참조:**
- `src/runtime/retry.ts` — keep existing retry/backoff helpers.

**Verification:**
- [x] `pnpm build`

---

### Step 2: Remove Stale Slack Transport Status Surface

Check whether `src/slack/transport.ts` is still used. If it is only a stale type
surface, remove the `setStatus(status: string)` member from `SlackMessageEvent`.
If the entire file is unused, leave broader deletion to a separate cleanup unless
TypeScript or tests require it.

**수정 파일:**
- `src/slack/transport.ts` — remove status-only type members that become
  misleading or unused.

**Verification:**
- [x] `pnpm typecheck`

---

### Step 3: Update Tests

Replace status assertions with reaction and reply assertions.

**수정 파일:**
- `test/slack-assistant.test.mjs` — remove `statuses` expectations, keep reply
  assertions, and add or preserve assertions for reaction calls:
  - success adds `thought_balloon`, adds `white_check_mark`, and removes
    `thought_balloon`;
  - interruption adds `hand` and removes `thought_balloon`;
  - error sends the error reply and removes `thought_balloon`.
- `test/slack-sender.test.mjs` — remove `setStatus` mocks and delete
  `SlackSender ignores setStatus failures`.

**참조:**
- `src/slack/assistant.ts` — existing reaction helpers are the behavior under
  test.
- `src/slack/sender.ts` — existing `sendReply()` chunking and retry behavior
  should remain covered.

**Verification:**
- [x] `pnpm build`
- [x] `node --test test/slack-assistant.test.mjs test/slack-sender.test.mjs`
- [x] `pnpm test`

---

## File Summary

| File | Action | LOC |
|------|--------|-----|
| `src/slack/assistant.ts` | Modify | ~10 removed |
| `src/slack/sender.ts` | Modify | ~10 removed |
| `src/slack/transport.ts` | Modify | ~1 removed |
| `test/slack-assistant.test.mjs` | Modify | ~40 |
| `test/slack-sender.test.mjs` | Modify | ~15 removed |

---

## Testing Strategy

| Test File | Coverage | LOC |
|-----------|----------|-----|
| `test/slack-assistant.test.mjs` | Slack turn lifecycle without Assistant status calls; reactions for success, interruption, and cleanup | ~40 |
| `test/slack-sender.test.mjs` | Reply chunking and retry after removing status responsibility | ~45 |

Run `pnpm build` before Node tests because tests import from `dist/`. Run the
focused Slack tests first, then the full test suite. Finish with a source search
to confirm active Slack code no longer contains `setStatus`, `assistant.threads.setStatus`,
or `생각 중`.

## Progress Log

- 2026-05-04: Started implementation on branch `remove-slack-assistant-status`.
- 2026-05-04: Removed Slack Assistant status usage from `src/slack/assistant.ts`.
- 2026-05-04: Simplified `SlackSender` to reply sending and retry only.
- 2026-05-04: Removed stale status typing from `src/slack/transport.ts`.
- 2026-05-04: Updated Slack tests to verify replies and reaction lifecycle without status calls.
- 2026-05-04: Implementation completed.
