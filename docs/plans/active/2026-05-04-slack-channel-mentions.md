---
title: Slack Channel Mentions
type: feat
status: active
created_at: 2026-05-04T13:46:16Z
---

# Slack Channel Mentions

## Context

`sky` currently handles Slack conversations through Bolt's Assistant layer. Direct-message Assistant threads work, and each Slack thread maps to an ACP session key formatted as `channelId:threadTs`. The missing behavior is ordinary public/private channel use: mentioning Sky in a channel should start a threaded conversation, and later replies in that same Slack thread should continue without requiring another mention once an ACP session has been persisted.

This plan adds a channel-message path while keeping the existing Assistant DM path unchanged. On the first channel mention in an existing Slack thread, Sky also fetches the earlier Slack thread messages and prepends them to the first ACP user input.

### Scope

**포함:**
- Public/private channel `app_mention` handling.
- Mention-free follow-up replies in a thread that already has an in-memory or persisted ACP session.
- Root channel mentions answered as Slack thread replies.
- First-turn Slack thread history prepend with bounded formatting.
- Focused regression tests and README Slack usage/scope notes.

**제외:**
- Replacing the current Slack Assistant DM flow.
- Adding a separate activation table for Slack threads.
- File attachment behavior changes for channel events.
- User-visible error when Slack thread history fetch fails.

---

## Architecture

```text
Slack Socket Mode App
  |
  +-- app.assistant(...)              -> existing DM Assistant flow
  |
  +-- channel event handlers          -> new channel flow
        |
        +-- slack/messages.ts         -> filter + mention normalization
        |
        +-- slack/thread-history.ts   -> conversations.replies formatting
        |
        +-- slack/channel.ts          -> session open/send + reactions + replies
              |
              v
           SessionManager             -> existing ACP session lifecycle
```

The new channel path reuses `toThreadId(channelId, threadTs)` from `src/slack/assistant.ts`, `SlackSender` retry/chunk behavior from `src/slack/sender.ts`, and the existing reaction lifecycle pattern from `src/slack/assistant.ts`.

Session continuation uses existing session persistence. The implementation should expose a small `SessionManager.has(key)` or equivalent query that returns true when the session is either open in memory or present in the configured `SessionStore`. This keeps the behavior aligned with the user's revised requirement: after a restart, only threads with a saved ACP session id continue without mention.

---

## Implementation Steps

### Step 0: Add Session Existence Query

**`src/session/types.ts`** (~65 LOC after changes)

Extend `SessionManager` with a query method:

```typescript
has(key: string): boolean;
```

**`src/session/manager.ts`** (~215 LOC after changes)

Implement `has(key)` by checking `sessions.has(key)` first and then `options.store?.get(key)` if the session is not currently open. This must not create or resume a provider session by itself.

**참조:**
- `src/session/store.ts` — existing `SessionStore.get(key)` persistence boundary.
- `src/session/manager.ts` — existing `open()` resume logic.

**Verification:**
- [x] `test/session-manager.test.mjs` covers in-memory sessions, persisted sessions, and missing sessions for `has()`.

---

### Step 1: Add Channel Message Normalization

**`src/slack/messages.ts`** (new, ~95 LOC)

Create a small normalization module for channel events.

```typescript
type NormalizeSlackMessageInput = {
  allowUnmentionedChannelMessage?: boolean;
  botUserId: string;
  event: SlackChannelMessageEvent;
  mentionLabel?: string;
};
```

Behavior:
- Reject bot messages, messages from the bot user, unsupported subtypes, unknown bot user id, and empty text.
- Replace `<@BOTID>` or `<@BOTID|label>` with `@sky`.
- If no mention is present, accept text only when `allowUnmentionedChannelMessage` is true.
- Do not add a mention label to unmentioned follow-up text.

**참조:**
- `/Users/taeyoung/Developer/workspace/reco/apps/slack-bot/src/slack/messages.ts` — same mention-normalization pattern.

**Verification:**
- [x] `test/slack-channel.test.mjs` or a focused message test covers mention replacement, allowed follow-up, missing mention ignore, bot ignore, subtype ignore, and empty ignore.

---

### Step 2: Add Slack Thread History Formatting

**`src/slack/thread-history.ts`** (new, ~110 LOC)

Create a formatting module that accepts normalized Slack thread messages fetched from `conversations.replies`.

```typescript
type SlackThreadMessage = {
  bot_id?: string;
  text?: string;
  ts: string;
  user?: string;
};
```

Export:
- `prependSlackThreadHistoryToPrompt({ currentContent, messages, maxCharacters, maxMessages })`
- `readSlackThreadMessages(value: unknown): SlackThreadMessage[]`

Format:

```text
[Slack thread history]
1777901000.000000 U123: 논의하던 내용
1777901200.000000 U456: 이전 답변

[User request]
@sky 이 내용 기준으로 정리해줘
```

Use conservative defaults of 100 messages and 20,000 formatted characters. If truncated, append `[Slack thread history truncated]` when it fits. Skip messages with empty text.

**참조:**
- `/Users/taeyoung/Developer/workspace/reco/apps/slack-bot/src/slack/events.ts` — `prependSlackThreadHistoryToPrompt` and formatting behavior.
- Slack docs: `conversations.replies` requires `channel` and `ts`, supports cursor pagination, and has channel-history scope/rate-limit constraints.

**Verification:**
- [x] Formatting tests cover normal prepend, empty history no-op, truncation, user author, bot author, and unknown author fallback.

---

### Step 3: Add Channel Event Handler

**`src/slack/channel.ts`** (new, ~220 LOC)

Create `createSlackChannelHandler(options)` that can be tested without constructing a real Bolt app.

Responsibilities:
1. Resolve `threadTs = event.thread_ts ?? event.ts`.
2. Build `threadId = toThreadId(event.channel, threadTs)`.
3. Compute `isExistingThread = sessionManager.has(threadId)`.
4. Normalize the message with `allowUnmentionedChannelMessage: isExistingThread` and `mentionLabel: '@sky'`.
5. Ignore rejected messages without reactions or replies.
6. Add `thought_balloon`, then open/send through `SessionManager`.
7. For a new session only, fetch history with `conversations.replies({ channel, ts: threadTs, latest: event.ts, inclusive: false })` and prepend it.
8. Stream assistant messages to `chat.postMessage({ channel, thread_ts: threadTs, text })` through `SlackSender`.
9. Add `white_check_mark`, `hand`, or an error reply matching the Assistant path, then remove `thought_balloon`.

History fetch failures should log and fall back to the current request. Do not fail the Slack turn for `missing_scope`, `thread_not_found`, rate-limit errors, or malformed responses.

**참조:**
- `src/slack/assistant.ts` — reaction lifecycle, transcript append, `sessionManager.send()` callback shape.
- `src/slack/sender.ts` — reply chunking and retry.
- `src/agents/memory/transcript.ts` — transcript writer can be reused with the same thread id.

**Verification:**
- [ ] Root channel mention opens `C123:messageTs` and replies with `thread_ts: messageTs`.
- [ ] Thread mention opens/reuses `C123:threadTs`.
- [ ] Existing session thread accepts unmentioned follow-up.
- [ ] Different unmentioned thread is ignored.
- [ ] First new session prepends history; existing session does not fetch history again.
- [ ] History fetch failure still sends only the current request.
- [ ] Reaction lifecycle matches success/interrupted/error paths.

---

### Step 4: Wire Bolt Events

**`src/slack/app.ts`** (~80 LOC after changes)

Extend `SlackAppOptions` to pass enough state into the channel handler. Register the existing Assistant first and then channel listeners.

Recommended wiring:
- Use `app.event('app_mention', ...)` for first mentions.
- Use `app.message(...)` for follow-up channel messages, with filtering in the handler so unrelated messages are ignored.
- Fetch `botUserId` with `app.client.auth.test()` during startup, before registering handlers.

Add a helper for `fetchThreadMessages()` that wraps `app.client.conversations.replies` with cursor pagination and a cap of 100 fetched messages. Pass only parsed `SlackThreadMessage[]` to `thread-history.ts`.

**참조:**
- `src/slack/app.ts` — current Bolt app creation and Assistant registration.
- Slack docs:
  - `app_mention`: https://docs.slack.dev/reference/events/app_mention/
  - `conversations.replies`: https://docs.slack.dev/reference/methods/conversations.replies/
  - Bolt message sending: https://docs.slack.dev/tools/bolt-js/concepts/message-sending/

**Verification:**
- [ ] `test/slack-channel.test.mjs` uses a fake Slack client to verify registration-independent handler behavior.
- [ ] If app wiring tests are added, fake Bolt client includes `auth.test`, `chat.postMessage`, `reactions`, and `conversations.replies`.

---

### Step 5: Update Documentation

**`README.md`** (~130 LOC after changes)

Update Slack usage and requirements:
- DM Assistant thread behavior remains supported.
- In public/private channels, mention Sky once in a root message or thread reply to start a conversation.
- Later replies in the same persisted session thread do not need a mention.
- Root channel mentions are answered in a Slack thread.
- Thread history is prepended only on the first channel session creation.
- Required Slack app subscriptions/scopes include `app_mentions.read`, public/private channel message events, and channel history scopes for `conversations.replies`.

Use current-state wording only.

**Verification:**
- [ ] README accurately reflects the implemented behavior and does not use relative-time phrases.

---

## File Summary

| File | Action | LOC |
|------|--------|-----|
| `src/session/types.ts` | Modify | ~5 |
| `src/session/manager.ts` | Modify | ~10 |
| `src/slack/messages.ts` | New | ~95 |
| `src/slack/thread-history.ts` | New | ~110 |
| `src/slack/channel.ts` | New | ~220 |
| `src/slack/app.ts` | Modify | ~45 |
| `README.md` | Modify | ~20 |
| `test/slack-channel.test.mjs` | New | ~280 |
| `test/session-manager.test.mjs` | Modify | ~40 |

---

## Testing Strategy

| Test File | Coverage | LOC |
|-----------|----------|-----|
| `test/session-manager.test.mjs` | `has()` for open, persisted, and missing sessions | ~40 |
| `test/slack-channel.test.mjs` | Channel mention, unmentioned follow-up, history prepend/fallback, reactions, ignores | ~280 |
| `test/slack-assistant.test.mjs` | Existing DM Assistant behavior remains unchanged | existing |

Run the full gate before handoff:

```bash
pnpm build
pnpm typecheck
pnpm test
```

Manual verification requires a Slack app with Socket Mode, channel message events, `app_mentions.read`, and channel history scopes. Verify:

1. Mention Sky in a public channel root message; Sky replies in that message's thread.
2. Reply in the same thread without a mention; Sky continues the same ACP session after a session id has been persisted.
3. Mention Sky midway through an existing Slack thread; the first ACP input includes previous thread history.
4. Send an unmentioned message in a different channel thread; Sky ignores it.
5. Restart the daemon; a thread with a persisted session continues without mention, while a thread without a persisted session requires another mention.

## Progress Log

- 2026-05-04: Step 0 completed. Added `SessionManager.has()` for in-memory and persisted session checks without opening provider sessions.
- 2026-05-04: Step 1 completed. Added channel message normalization for bot mentions, existing-thread follow-ups, and ignored Slack messages.
- 2026-05-04: Step 2 completed. Added Slack thread history parsing and bounded prompt prepend formatting.
