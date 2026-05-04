---
title: Codex Base Instructions
type: feat
status: active
created_at: 2026-05-04T15:15:14Z
---

# Codex Base Instructions

## Context

Sky currently assembles a workspace prompt from files under the configured
`workspace` and passes that prompt to all providers as `systemPrompt`.
Anthropic ACP receives it through Claude-specific metadata, while `openai/*`
currently receives it through `CODEX_CONFIG.developer_instructions`. That makes
Sky's prompt a Codex developer-role instruction instead of replacing Codex's
base/model instructions.

Codex also reads user-level Codex context from the default `~/.codex` home. In
Sky-managed Codex sessions this can unintentionally inject `~/.codex/AGENTS.md`
and user `~/.codex/config.toml` settings into the Slack bot's runtime. The
intended outcome is for Sky to provide the complete base instruction file for
Codex and to isolate Sky-managed Codex sessions from the user's default Codex
home, while preserving existing ChatGPT/API-key authentication paths.

### Scope

**포함:**
- Assemble workspace prompt files in `SOUL.md`, `AGENTS.md`, `USER.md`,
  `MEMORY.md` order.
- For `openai/*` ACP sessions, write the resolved prompt snapshot to a
  Sky-owned Codex instruction file.
- Start Codex ACP with a Sky-owned `CODEX_HOME`.
- Pass `model_instructions_file` instead of `developer_instructions` through
  `CODEX_CONFIG`.
- Symlink Sky's Codex auth file to the user's existing `~/.codex/auth.json`
  when available.
- Add focused regression tests and README updates.

**제외:**
- Changing Anthropic ACP session parameters.
- Forking or patching `@agentclientprotocol/codex-acp`.
- Changing the user-facing `model` setting format.
- Migrating existing Codex session history or Codex config files.

---

## Architecture

```text
Slack thread
  |
  v
SessionManager
  |
  v
ProviderConfig.systemPrompt snapshot
  |
  +-- anthropic/* -> existing Claude ACP metadata path
  |
  +-- openai/*    -> src/providers/acp.ts
                      |
                      +-- ~/.sky/codex-home/sky-system-prompt.md
                      +-- ~/.sky/codex-home/auth.json -> ~/.codex/auth.json
                      |
                      v
                    CODEX_HOME=~/.sky/codex-home
                    CODEX_CONFIG.model_instructions_file=<prompt file>
                      |
                      v
                    @agentclientprotocol/codex-acp
                      |
                      v
                    codex app-server
```

The provider boundary remains unchanged: `SessionManager` still resolves and
persists an exact `systemPrompt` snapshot per session. The OpenAI provider
materializes that snapshot as a Codex model instruction file before launching
the Codex ACP adapter. Using an isolated `CODEX_HOME` prevents default
`~/.codex/AGENTS.md` and `~/.codex/config.toml` from entering Sky-managed
sessions.

---

## Implementation Steps

### Step 0: Extract Prompt Loading For Ordering Tests

Move the workspace prompt file list and loader into a testable export while
preserving the current startup logging behavior.

**수정 파일:**
- `src/bot.ts` — change the prompt file order to `SOUL.md`, `AGENTS.md`,
  `USER.md`, `MEMORY.md`; export or extract the prompt loader enough for tests.

**참조:**
- `src/bot.ts` — existing `safeRead()` and `loadSystemPrompt()` behavior.
- `src/session/manager.ts` — existing prompt snapshot/resume behavior remains
  unchanged.

**Verification:**
- [ ] Add a prompt loader regression test that verifies loaded file order.

---

### Step 1: Add Sky-Owned Codex Home Preparation

Add a small Codex runtime preparation path in the shared ACP provider, scoped to
the `openai` branch only.

**`src/providers/acp.ts`**

Add helpers that:
- Derive `codexHome` as `path.join(SKY_DIR, 'codex-home')`.
- Derive `promptPath` as `path.join(codexHome, 'sky-system-prompt.md')`.
- Create `codexHome` recursively.
- Write `config.systemPrompt` to `promptPath` before launching Codex ACP.
- Ensure `path.join(codexHome, 'auth.json')` points to the user's
  `~/.codex/auth.json` when the source file exists and the target does not.

Auth symlink behavior:
- If `~/.codex/auth.json` does not exist, skip symlink creation.
- If `~/.sky/codex-home/auth.json` already exists, do not overwrite it.
- If a race produces `EEXIST`, treat it as success.
- If any directory or prompt-file write fails, fail provider creation rather
  than starting Codex without Sky instructions.

**수정 파일:**
- `src/providers/acp.ts` — import filesystem/path utilities and `SKY_DIR`, add
  Codex home preparation helpers.

**참조:**
- `src/settings.ts` — reuse existing `SKY_DIR`.
- `src/runtime/pending-restart.ts` and `src/daemon.ts` — existing pattern of
  creating `SKY_DIR` recursively before writing Sky runtime files.

**Verification:**
- [ ] Unit test covers prompt file creation with exact system prompt contents.
- [ ] Unit test covers auth symlink creation with a temporary `HOME`.

---

### Step 2: Switch Codex Config To `model_instructions_file`

Replace the Codex-specific config payload so Sky's prompt is used as Codex
base/model instructions.

**`src/providers/acp.ts`**

Update `buildCodexAgentEnv()` so the `openai/*` runtime env:
- Forces `CODEX_HOME` to the Sky-owned Codex home, overriding inherited
  `process.env.CODEX_HOME`.
- Sets `CODEX_CONFIG` to include `model`, `model_instructions_file`, and
  `project_doc_max_bytes`.
- Does not include `developer_instructions`.
- Keeps the existing allowlist for API keys, proxy, PATH, temp, and certificate
  env vars.
- Continues not to forward `CODEX_PATH`, `MODEL_PROVIDER`, or unrelated secret
  env vars.

**수정 파일:**
- `src/providers/acp.ts` — update `buildCodexAgentEnv()` and the
  `resolveAcpAgentRuntime()` `openai` branch as needed to pass prepared paths.

**참조:**
- `test/acp-provider.test.mjs` — existing OpenAI runtime env assertions.
- `@agentclientprotocol/codex-acp` local behavior — adapter passes
  `CODEX_CONFIG` through to Codex app-server config.

**Verification:**
- [ ] Unit test asserts `CODEX_CONFIG.developer_instructions` is absent.
- [ ] Unit test asserts `CODEX_CONFIG.model_instructions_file` points to the
  Sky prompt file.
- [ ] Unit test asserts `runtime.env.CODEX_HOME` is the Sky-owned Codex home,
  even when `process.env.CODEX_HOME` was set.

---

### Step 3: Update Documentation

Document the new prompt ordering and Codex isolation behavior.

**수정 파일:**
- `README.md` — update prompt file order from `AGENTS.md`, `SOUL.md`,
  `USER.md`, `MEMORY.md` to `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`.
- `README.md` — mention that `openai/*` sessions use a Sky-owned Codex home and
  `model_instructions_file`, with `auth.json` symlinked from the default Codex
  home when present.

**Verification:**
- [ ] `rg -n "AGENTS.md.*SOUL.md|SOUL.md.*AGENTS.md" README.md src`

---

### Step 4: Regression Tests And End-To-End Verification

Add focused tests around the provider env, prompt materialization, auth symlink,
and prompt ordering.

**수정 파일:**
- `test/acp-provider.test.mjs` — update the OpenAI runtime test and add file
  materialization/symlink coverage.
- New or existing prompt-loader test file — cover `SOUL.md`, `AGENTS.md`,
  `USER.md`, `MEMORY.md` ordering and missing-file behavior.

**Verification:**
- [ ] `pnpm build`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] Manual check, if useful: run Codex `debug prompt-input` with an isolated
  `CODEX_HOME` to confirm default `~/.codex/AGENTS.md` is not injected.

---

## File Summary

| File | Action | LOC |
|------|--------|-----|
| `src/providers/acp.ts` | Modify | ~70 |
| `src/bot.ts` | Modify | ~20 |
| `test/acp-provider.test.mjs` | Modify | ~80 |
| `test/system-prompt.test.mjs` or similar | New | ~80 |
| `README.md` | Modify | ~10 |

---

## Testing Strategy

| Test File | Coverage | LOC |
|-----------|----------|-----|
| `test/acp-provider.test.mjs` | Codex env config, prompt file materialization, auth symlink, env allowlist | ~80 changed |
| `test/system-prompt.test.mjs` | Workspace prompt file ordering and missing-file behavior | ~80 |

Run the full project gate after implementation:

```bash
pnpm build
pnpm typecheck
pnpm test
```
