---
title: Add Codex ACP Provider
type: feat
status: active
created_at: 2026-05-04T10:27:48Z
---

# Add Codex ACP Provider

## Context

`sky` currently supports only `anthropic/*` models through `@agentclientprotocol/claude-agent-acp`. The provider layer already speaks ACP and persists session ids, model ownership, and frozen system prompt snapshots, so adding Codex should not require changes to Slack session management.

This plan adds `openai/*` model support using the ACP Registry Codex CLI adapter from `@zed-industries/codex-acp`. The user-facing setting remains the existing single `model` field, for example `openai/gpt-5.5`. Sky's assembled workspace prompt must apply to Codex sessions too, while preserving Codex's built-in coding-agent instructions.

### Scope

**포함:**
- Add `@zed-industries/codex-acp` as an internal dependency with `pnpm`.
- Accept `openai/*` in provider model parsing.
- Select the ACP subprocess by provider: Claude ACP for `anthropic/*`, Codex ACP for `openai/*`.
- Pass Codex model and Sky prompt via Codex config overrides.
- Disable Codex project-doc discovery for these sessions to avoid duplicating Sky's `AGENTS.md` prompt content.
- Keep the existing `SessionManager`, `SessionStore`, Slack flow, streaming contract, and ACP lifecycle.
- Add focused regression tests and update README/settings examples.

**제외:**
- Provider-specific settings schema such as `providers.openai`.
- Routing different Slack threads to different providers beyond the existing `model` setting.
- Rich Slack rendering for Codex tool calls, plans, thoughts, or usage updates.
- Replacing Codex base instructions or using `codex app-server`.

---

## Architecture

```text
Slack Assistant thread
      |
      v
SessionManager
      |
      v
ProviderSession
      |
      v
Shared ACP session runtime
      |
      +-- anthropic/* -> node dist of @agentclientprotocol/claude-agent-acp
      |
      +-- openai/*    -> platform binary from @zed-industries/codex-acp
```

The implementation should keep one ACP client/runtime path for initialize, session creation/resume/load, prompt streaming, cancellation, and close. Provider-specific code should be limited to model parsing, subprocess resolution, process args, and `NewSessionRequest` parameter construction.

For Codex, map Sky's assembled `systemPrompt` to Codex `developer_instructions` through CLI `-c` overrides. Do not map it to `base_instructions`, because that would replace Codex's built-in coding-agent instructions. Also pass `project_doc_max_bytes=0`, because Sky already reads workspace `AGENTS.md`, `SOUL.md`, `USER.md`, and `MEMORY.md` into a frozen prompt snapshot.

---

## Implementation Steps

### Step 0: Dependency

Add the Codex ACP adapter with the package manager.

```bash
pnpm add @zed-industries/codex-acp
```

**수정 파일:**
- `package.json` — add `@zed-industries/codex-acp`.
- `pnpm-lock.yaml` — package manager update, including platform optional dependencies.

**Verification:**
- [x] `pnpm install --frozen-lockfile`

---

### Step 1: Provider Model Parsing

**`src/providers/model.ts`** (~35 LOC)

Extend `ParsedModel.provider` from only `'anthropic'` to `'anthropic' | 'openai'`.

Rules:
- `anthropic/<modelId>` remains accepted.
- `openai/<modelId>` is accepted and keeps the provider-stripped `modelId`.
- malformed values still fail with the existing `"<provider>/<model>"` error.
- providers other than `anthropic` and `openai` still fail with `Unsupported model provider`.

**수정 파일:**
- `src/providers/model.ts`
- `test/provider-model.test.mjs`

**참조:**
- `src/providers/model.ts` — current parser boundary.
- `test/provider-model.test.mjs` — existing parser regression tests.

**Verification:**
- [x] `pnpm build`
- [x] `pnpm test`

---

### Step 2: Provider-Specific ACP Process Resolution

**`src/providers/acp.ts`** (~430 LOC after changes)

Refactor process creation so provider-specific command resolution is explicit.

Recommended shape:
- Keep `AcpAgentConnection`, `AcpSessionState`, `createClient`, `flushStreamText`, and `createAcpSession` as the shared runtime.
- Introduce a small provider runtime descriptor:

```typescript
type AcpAgentRuntime = {
  command: string;
  args: string[];
};
```

- For `anthropic`, preserve the current Node subprocess:
  - `command: process.execPath`
  - `args: [resolveClaudeAgentAcpPath()]`
- For `openai`, resolve the installed Codex ACP platform binary rather than shelling through `npx`.

Codex binary resolution should follow the npm wrapper's package mapping:
- `darwin/arm64` -> `@zed-industries/codex-acp-darwin-arm64/bin/codex-acp`
- `darwin/x64` -> `@zed-industries/codex-acp-darwin-x64/bin/codex-acp`
- `linux/arm64` -> `@zed-industries/codex-acp-linux-arm64/bin/codex-acp`
- `linux/x64` -> `@zed-industries/codex-acp-linux-x64/bin/codex-acp`
- `win32/arm64` -> `@zed-industries/codex-acp-win32-arm64/bin/codex-acp.exe`
- `win32/x64` -> `@zed-industries/codex-acp-win32-x64/bin/codex-acp.exe`

Use `fileURLToPath(import.meta.resolve(...))`, as `resolveClaudeAgentAcpPath()` already does. Throw a clear unsupported platform/architecture error when no mapping exists.

Keep `defaults.createAgentConnection` for tests. Add a test-only seam only if needed to inspect process runtime without spawning a real binary.

**수정 파일:**
- `src/providers/acp.ts`
- `test/acp-provider.test.mjs`

**참조:**
- `src/providers/acp.ts` — current `createProcessConnection()` and `resolveClaudeAgentAcpPath()`.
- `/Users/taeyoung/Developer/oss/codex-acp/npm/bin/codex-acp.js` — upstream platform package mapping.

**Verification:**
- [x] Unit tests verify runtime selection without spawning the real Codex binary.
- [x] `pnpm typecheck`

---

### Step 3: Provider-Specific Session Parameters

**`src/providers/acp.ts`** (~430 LOC after changes)

Split the current `buildSessionParams()` into provider-specific builders.

For `anthropic/*`, preserve the current shape:
- `cwd`
- `mcpServers`
- `_meta.systemPrompt`
- `_meta.claudeCode.options.model`
- `maxTurns`, `tools`, `settingSources: []`, `env`, and `extraArgs.replay-user-messages`

For `openai/*`, build an ACP `NewSessionRequest` that avoids Claude-specific metadata:
- `cwd`
- `mcpServers`
- no `_meta.claudeCode`

Pass Codex-specific settings through process args:

```text
-c model="gpt-5.5"
-c developer_instructions="<Sky assembled system prompt>"
-c project_doc_max_bytes=0
```

Use TOML-safe serialization for override values. Prefer `JSON.stringify(string)` for string values because it is valid TOML basic-string syntax for simple and escaped strings. Numeric values can be literal strings such as `project_doc_max_bytes=0`.

Do not pass Claude `tools`, `maxTurns`, `settingSources`, or `extraArgs` to Codex in the initial implementation. Codex tool availability is governed by Codex config and ACP client permissions.

**수정 파일:**
- `src/providers/acp.ts`
- `test/acp-provider.test.mjs`

**참조:**
- `src/bot.ts` — `loadSystemPrompt()` already assembles workspace prompt files.
- `src/session/manager.ts` — persists the resolved prompt snapshot for resume.
- `/Users/taeyoung/Developer/oss/codex/codex-rs/core/src/config/mod.rs` — Codex supports `user_instructions`, `base_instructions`, and `developer_instructions`.
- `/Users/taeyoung/Developer/oss/codex/codex-rs/core/src/project_doc.rs` — `project_doc_max_bytes=0` disables project-doc reading.

**Verification:**
- [x] Tests assert `openai/gpt-5.5` produces Codex args with model, developer instructions, and `project_doc_max_bytes=0`.
- [x] Tests assert OpenAI session params do not include `_meta.claudeCode`.
- [x] Tests assert Anthropic session params remain unchanged.

---

### Step 4: Streaming, Permissions, And Lifecycle Regression Coverage

Keep the current streaming and lifecycle behavior.

Existing behavior to preserve:
- `agent_message_chunk` text accumulates into final text.
- Non-agent updates flush pending streamed text.
- `prompt.stopReason === "end_turn"` succeeds.
- `cancelled` and other stop reasons surface as current errors.
- `interrupt()` maps to ACP `cancel`.
- `close()` attempts `closeSession` and closes the process connection.

Permission handling should stay provider-neutral:
- Prefer `_meta.claudeCode.toolName` when present.
- Fall back to `toolCall.title`.
- Select an allow option when the resolved tool name matches `config.tools`.
- Select a reject option when it does not.
- If the tool name cannot be resolved, keep the existing permissive behavior for now to avoid blocking Codex tool shapes that differ from Claude.

**수정 파일:**
- `src/providers/acp.ts`
- `test/acp-provider.test.mjs`

**참조:**
- `src/providers/acp.ts` — `extractToolName()` and `createClient()`.
- `test/acp-provider.test.mjs` — current streaming, resume fallback, interrupt, and error tests.

**Verification:**
- [x] Existing ACP provider tests still pass.
- [x] Add permission tests for Claude metadata and title fallback if coverage is not already present.

---

### Step 5: Documentation

Update public docs so settings examples and feature descriptions match the new provider support.

**수정 파일:**
- `README.md` — describe supported providers as `anthropic/*` and `openai/*`, show `openai/gpt-5.5`, and mention Codex authentication through Codex/OpenAI credentials.

Do not use relative-time phrases. Describe only the repository's state after the implementation.

**Verification:**
- [x] README examples are internally consistent.

---

## File Summary

| File | Action | LOC |
|------|--------|-----|
| `package.json` | Modify | ~1 dependency |
| `pnpm-lock.yaml` | Modify | package-manager generated |
| `src/providers/model.ts` | Modify | ~35 |
| `src/providers/acp.ts` | Modify | ~430 |
| `test/provider-model.test.mjs` | Modify | ~45 |
| `test/acp-provider.test.mjs` | Modify | ~330 |
| `README.md` | Modify | ~90 |

---

## Testing Strategy

| Test File | Coverage | LOC |
|-----------|----------|-----|
| `test/provider-model.test.mjs` | `anthropic/*`, `openai/*`, malformed values, unsupported providers | ~45 |
| `test/acp-provider.test.mjs` | provider runtime selection, Claude session metadata preservation, Codex args/session params, streaming, resume fallback, interrupt, permission fallback | ~330 |
| `test/settings.test.mjs` | Existing settings compatibility; no schema change expected | existing |

Run the full gate before handoff:

```bash
pnpm test
pnpm typecheck
pnpm build
```

For an end-to-end smoke test after unit verification, configure a local `~/.sky/settings.json` with:

```json
{
  "slack": {
    "botToken": "xoxb-...",
    "appToken": "xapp-..."
  },
  "model": "openai/gpt-5.5",
  "workspace": "/Users/taeyoung/.sky/workspace"
}
```

Then run `pnpm dev` or `sky run` and send a Slack Assistant thread message. Expected result: Sky starts a Codex ACP session, streams text back to Slack, persists the session id, and resumes the same thread after restart.

## Progress Log

- 2026-05-04: Added `@zed-industries/codex-acp` dependency and verified the lockfile with `pnpm install --frozen-lockfile`.
- 2026-05-04: Extended provider model parsing to accept `openai/*` and verified with `pnpm build` and `pnpm test`.
- 2026-05-04: Added provider-specific ACP runtime selection and verified Codex runtime selection plus `pnpm typecheck`.
- 2026-05-04: Added Codex CLI config overrides and OpenAI session params without Claude metadata, verified with ACP provider tests.
- 2026-05-04: Added permission selection regression tests for Claude metadata, title fallback, and unknown tool names.
- 2026-05-04: Updated README provider, settings, and authentication examples for `openai/gpt-5.5`.
