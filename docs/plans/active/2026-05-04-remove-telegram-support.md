---
title: Remove Telegram Support
type: refactor
status: active
created_at: 2026-05-04T07:22:38Z
---

# Remove Telegram Support

## Context

`sky` currently carries two transports: Slack Assistant threads and Telegram chats.
Taeyoung confirmed Telegram is no longer used, so the Telegram runtime,
configuration, diagnostics, tests, and dependencies should be removed rather
than disabled.

The intended outcome is a Slack-only ACP agent bot. Slack session behavior,
ACP provider behavior, daemon commands, memory, and dream agents stay intact.

### Scope

**포함:**
- Delete Telegram transport source files and the Telegram polling runtime.
- Require Slack settings and reject leftover `telegram` settings through the strict schema.
- Simplify startup and status output to Slack-only behavior.
- Remove Telegram-specific tests and update remaining fixtures.
- Remove `grammy` and `@grammyjs/runner` with `pnpm`.
- Update README and CLI/package descriptions to describe Slack-only behavior.

**제외:**
- Migrating or deleting existing SQLite session rows.
- Changing Slack session keys or ACP resume semantics.
- Editing historical completed plan documents that mention Telegram as past context.

---

## Architecture

```text
Slack Assistant thread
      |
      v
src/slack/assistant.ts
      |
      v
SessionManager
      |
      v
ACP Provider
      |
      v
claude-agent-acp subprocess
```

`src/bot.ts` remains the process orchestration entry point. It should load
settings, create the main agent and session manager, start Slack, trigger any
pending post-restart Slack message, then wait for shutdown.

The Telegram-specific loop disappears:

```text
BotRuntime -> TelegramNetworkClient -> TelegramPollingSession -> grammy Bot
```

---

## Implementation Steps

### Step 0: Remove Telegram Dependencies

Use the package manager so `package.json` and `pnpm-lock.yaml` stay consistent.

```bash
pnpm remove grammy @grammyjs/runner
```

**수정 파일:**
- `package.json` — remove Telegram dependencies and update the description.
- `pnpm-lock.yaml` — package manager generated dependency graph update.

**Verification:**
- [x] `rg -n "grammy|@grammyjs/runner" package.json pnpm-lock.yaml` returns no live dependency references.

---

### Step 1: Delete Telegram Runtime And Transport Code

Delete Telegram-only modules.

**수정 파일:**
- `src/telegram/` — delete the directory.
- `src/runtime/bot-runtime.ts` — delete; it only orchestrates Telegram polling.
- `src/runtime/health-store.ts` — delete if `statusCommand` no longer imports it.

**참조:** `src/slack/app.ts` and `src/slack/assistant.ts` already provide the
remaining transport path and should be reused unchanged unless type fallout
requires a narrow adjustment.

**Verification:**
- [ ] `rg -n "telegram|Telegram|grammy|polling" src` has no current-runtime matches. Incidental non-Telegram wording such as memory cadence can remain if accurate.

---

### Step 2: Simplify Settings And Startup

Make Slack the only configured transport.

**`src/settings.ts`**
- Remove `telegramSettingsSchema`.
- Make `slack` required.
- Keep `model` required and `workspace` defaulted.
- Keep `.strict()` so leftover `telegram` keys fail as unrecognized settings.
- Update the missing-file guidance to say Slack settings are required.

**`src/bot.ts`**
- Remove `BotRuntime` import and all `settings.telegram` branching.
- Start Slack unconditionally from required `settings.slack`.
- Keep `triggerPostRestartIfPending`, `waitForShutdownSignal`, session cleanup, and Slack shutdown.
- Update the post-restart comment that mentions Telegram-only deployments.

**`src/index.ts`**
- Change the CLI description to Slack-only wording.

**Verification:**
- [ ] `pnpm build`
- [ ] `pnpm test -- test/settings.test.mjs`

---

### Step 3: Simplify Status Output

Remove Telegram health reporting from `sky status`.

**`src/commands/status.ts`**
- Remove `readHealthSnapshot` import and `printHealth()`.
- When settings are readable, print Slack configuration status, model, and workspace.
- Keep existing daemon PID, stale PID cleanup, and log file output.
- Do not print `telegram runtime: disabled`; Telegram is not a supported runtime.

**Verification:**
- [ ] `pnpm build`
- [ ] Run `node dist/index.js status` after build with a valid settings file, or document why local settings are unavailable.

---

### Step 4: Update Tests

Delete tests that only cover Telegram internals.

**수정 파일:**
- `test/getme-diagnostics.test.mjs` — delete.
- `test/network-client.test.mjs` — delete.
- `test/error-classifier.test.mjs` — delete.
- `test/settings.test.mjs` — require Slack config, reject missing Slack, and reject `telegram`.
- `test/session-store.test.mjs` — replace Telegram-flavored fixture keys with neutral legacy keys.
- `test/retry.test.mjs` — replace Telegram-only timeout descriptions with generic descriptions if the wording no longer matches current runtime concepts.

**Verification:**
- [ ] `pnpm test`

---

### Step 5: Update README

Preserve the existing Korean documentation style and describe the current
Slack-only repo state.

**수정 파일:**
- `README.md` — remove Telegram setup, runtime health, command, and usage references.

Keep:
- Slack Assistant thread behavior.
- ACP session behavior.
- Settings, build, test, CLI, and operational notes that remain accurate.

**Verification:**
- [ ] `rg -n "telegram|Telegram|grammy|polling" README.md package.json src test` has no live-product references.

---

## File Summary

| File | Action | LOC |
|------|--------|-----|
| `package.json` | Modify | ~35 |
| `pnpm-lock.yaml` | Modify | generated |
| `src/telegram/` | Delete | ~700 |
| `src/runtime/bot-runtime.ts` | Delete | ~400 |
| `src/runtime/health-store.ts` | Delete | ~160 |
| `src/settings.ts` | Modify | ~40 |
| `src/bot.ts` | Modify | ~240 |
| `src/commands/status.ts` | Modify | ~50 |
| `src/index.ts` | Modify | ~25 |
| `test/getme-diagnostics.test.mjs` | Delete | ~45 |
| `test/network-client.test.mjs` | Delete | ~25 |
| `test/error-classifier.test.mjs` | Delete | ~35 |
| `test/settings.test.mjs` | Modify | ~60 |
| `test/session-store.test.mjs` | Modify | ~130 |
| `test/retry.test.mjs` | Modify | ~60 |
| `README.md` | Modify | ~110 |

---

## Testing Strategy

| Test File | Coverage | LOC |
|-----------|----------|-----|
| `test/settings.test.mjs` | Slack-required settings and strict rejection of Telegram keys | ~60 |
| `test/session-store.test.mjs` | Existing store behavior with neutral legacy fixture keys | ~130 |
| `test/retry.test.mjs` | Generic retry helpers without Telegram-specific wording | ~60 |
| `test/slack-assistant.test.mjs` | Existing Slack assistant behavior remains green | existing |
| `test/slack-sender.test.mjs` | Existing Slack sender behavior remains green | existing |

Run the full gate before handoff:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
rg -n "telegram|Telegram|grammy|polling" src test README.md package.json
```

If the final `rg` reports only historical completed plan references, leave them
unchanged because they document past repo state.

## Progress Log

- 2026-05-04: Removed Telegram package dependencies and updated package metadata.
