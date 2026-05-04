---
title: ACP Stream Flush
type: fix
status: active
created_at: 2026-05-04T07:42:20Z
---

# ACP Stream Flush

## Context

`sky` currently collects ACP `agent_message_chunk` text in
`src/providers/acp.ts` and calls `CollectOptions.onMessage` only once after
`agent.prompt()` finishes. Slack already sends each `onMessage` callback through
`SlackSender.sendReply`, so the buffering point is the ACP provider, not the
Slack transport.

This causes assistant text that was produced before a tool call to arrive only
after all tool work and final assistant text have completed. The intended
outcome is to deliver the assistant text accumulated so far whenever the ACP
stream switches away from assistant text, and to deliver any remaining text when
the prompt ends.

### Scope

**포함:**
- Flush accumulated assistant text when a session update is not
  `agent_message_chunk`.
- Flush remaining assistant text when `collect()` reaches prompt completion.
- Preserve the existing `ProviderResult.text` value as the full accumulated
  assistant text.
- Add provider-level regression coverage for flush boundaries.

**제외:**
- Rendering tool calls or tool results to Slack.
- Changing `CollectOptions` or `ProviderSession` public types.
- Adding timer-based batching or Slack message update/edit streaming.

---

## Architecture

```text
@agentclientprotocol/claude-agent-acp
      |
      v
Client.sessionUpdate(params)
      |
      v
src/providers/acp.ts
      |  agent_message_chunk text -> append to finalText + pending stream buffer
      |  any other update          -> flush pending stream buffer via onMessage
      |  prompt completion         -> flush pending stream buffer
      v
SessionManager onMessage guard
      |
      v
SlackAssistant -> SlackSender.sendReply
```

The flush policy belongs in `src/providers/acp.ts` because that is where ACP
update boundaries are visible. `src/slack/assistant.ts` already treats each
`onMessage` callback as a separate reply and should not need transport-specific
logic for ACP update types.

---

## Implementation Steps

### Step 0: Add Provider Stream State

Extend the internal ACP provider state with a per-turn stream buffer and a
callback reference for the active collection.

**수정 파일:**
- `src/providers/acp.ts` — add internal state for pending assistant text and
  active `onMessage` delivery.

**Implementation notes:**
- Keep `state.finalText` as the complete response accumulator.
- Add a separate pending stream buffer, for example `streamText`.
- Avoid changing exported provider types in `src/providers/types.ts`.

**Verification:**
- [x] `pnpm build`

---

### Step 1: Flush On Non-Agent Updates And Prompt Completion

Update `createClient(...).sessionUpdate` so that text
`agent_message_chunk` updates append to both accumulators. If the update is not
`agent_message_chunk`, flush the pending stream buffer through the active
`onMessage` callback and clear it.

At the end of `collect()`, flush any remaining pending stream buffer before
returning. Do not call `onMessage(finalText)` after prompt completion, because
that would duplicate chunks already flushed during the turn.

**수정 파일:**
- `src/providers/acp.ts` — implement a small internal `flushStreamText()` helper
  and call it from non-agent updates and prompt completion.

**참조:**
- `src/providers/acp.ts` — current `isTextChunk()` and `sessionUpdate()`
  behavior.
- `src/slack/assistant.ts` — existing `onMessage` callback sends each message
  with `SlackSender.sendReply`.

**Verification:**
- [ ] `pnpm build`

---

### Step 2: Add Regression Tests

Add a provider test that simulates this ACP update sequence:

1. `agent_message_chunk` with initial assistant text.
2. A non-agent update such as `tool_call`.
3. `agent_message_chunk` with final assistant text.
4. `agent.prompt()` returns `end_turn`.

Expected behavior:
- `onMessage` receives the initial assistant text before the final text.
- `onMessage` receives the final assistant text at prompt completion.
- `ProviderResult.text` remains the concatenated full assistant text.

Also keep the existing buffered-text test valid for the no-boundary case: if
only `agent_message_chunk` updates arrive, one callback is emitted at prompt
completion.

**수정 파일:**
- `test/acp-provider.test.mjs` — add the boundary regression test and adjust
  expectations only where needed.

**Verification:**
- [ ] `pnpm build`
- [ ] `pnpm test -- test/acp-provider.test.mjs`
- [ ] `pnpm test`

---

## File Summary

| File | Action | LOC |
|------|--------|-----|
| `src/providers/acp.ts` | Modify | ~30 |
| `test/acp-provider.test.mjs` | Modify | ~45 |

---

## Testing Strategy

| Test File | Coverage | LOC |
|-----------|----------|-----|
| `test/acp-provider.test.mjs` | ACP text flush at non-agent update boundaries and prompt completion | ~45 |

Run `pnpm build` first because tests import from `dist/`, then run the focused
provider test. Run the full `pnpm test` gate before handoff.

## Progress Log

- 2026-05-04: Added ACP provider stream state and verified `pnpm build`.
