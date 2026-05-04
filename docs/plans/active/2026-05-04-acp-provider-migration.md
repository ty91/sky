---
title: ACP Provider Migration
type: refactor
status: active
created_at: 2026-05-04T05:54:03Z
---

# ACP Provider Migration

## Context

`sky` currently uses `@anthropic-ai/claude-agent-sdk` directly in `src/providers/claude.ts`.
That couples the Slack/Telegram bot runtime to Claude's SDK shape and makes it
hard to add another agent runtime later.

This plan migrates the provider layer to Agent Client Protocol (ACP). The first
runtime target is `anthropic/*` via `@agentclientprotocol/claude-agent-acp`.
Codex/OpenAI models are intentionally not implemented in this plan, but the
model parsing and provider boundary should make that addition straightforward.

Existing pre-migration Claude SDK sessions do not need to resume. New ACP
sessions created after this migration must resume across bot restarts.

### Scope

**포함:**
- Replace the direct Claude SDK provider with an ACP provider.
- Support top-level `model: "anthropic/<modelId>"` in `~/.sky/settings.json`.
- Reject unsupported providers such as `openai/*` with a clear error.
- Persist ACP session IDs with model ownership in the SQLite session store.
- Keep `restart_harness` available through a stdio MCP server.
- Update main bot, memory agent, dream agent, tests, and README.

**제외:**
- Resuming sessions created by the old direct Claude SDK provider.
- Implementing `openai/*` or Codex ACP.
- Changing Slack/Telegram session keys or user-facing transport behavior.

---

## Architecture

```text
Slack / Telegram / memory / dream
      |
      v
SessionManager
      |
      v
ProviderSession
      |
      v
AcpProviderSession
      |
      +-- @agentclientprotocol/sdk ClientSideConnection
      |
      +-- stdio subprocess: @agentclientprotocol/claude-agent-acp
              |
              +-- Claude Agent SDK internally
              |
              +-- stdio MCP: sky restart_harness server
```

`SessionManager` keeps its public contract: `open`, `send`, `interrupt`,
`close`, `purge`, and `closeAll`. The new provider hides ACP initialization,
session creation/resume, prompt streaming, cancellation, and subprocess
lifecycle behind the existing `ProviderSession` interface.

The provider no longer imports `@anthropic-ai/claude-agent-sdk`. Claude-specific
runtime behavior lives behind `claude-agent-acp`.

---

## Implementation Steps

### Step 0: Dependencies And Package Shape

Add ACP and MCP runtime dependencies with `pnpm`.

**수정 파일:**
- `package.json` — replace direct Claude Agent SDK dependency with ACP/MCP dependencies.
- `pnpm-lock.yaml` — package manager update.

**Dependency changes:**
- Add `@agentclientprotocol/sdk`.
- Add `@agentclientprotocol/claude-agent-acp`.
- Add `@modelcontextprotocol/sdk` for the stdio `restart_harness` MCP server.
- Remove direct `@anthropic-ai/claude-agent-sdk` usage after source imports are gone.

**Verification:**
- [x] `pnpm install`
- [x] `pnpm typecheck`

---

### Step 1: Model Settings And Parsing

**`src/settings.ts`** (~80 LOC)

Replace `settings.claude.model` with a required top-level `model` string.
Use a strict object schema so old `claude` config fails instead of being
silently ignored.

**`src/providers/model.ts`** (~80 LOC, new)

Add a small parser for provider-qualified models.

```typescript
type ParsedModel = {
  provider: 'anthropic';
  modelId: string;
  raw: string;
};
```

Rules:
- `anthropic/<modelId>` is accepted when `<modelId>` is non-empty.
- Any other provider fails with an unsupported provider error.
- Missing `/`, empty provider, or empty model ID fails with a settings-style error.

**수정 파일:**
- `src/settings.ts` — new top-level `model`; remove `claude`.
- `src/bot.ts` — log and pass `settings.model`.
- `src/commands/memory.ts` — create ACP provider factory.
- `src/commands/dream.ts` — create ACP provider factory.
- `src/agents/main.ts` — default model becomes `anthropic/claude-opus-4-7`.
- `src/agents/memory/agent.ts` — hardcoded model becomes provider-qualified.
- `src/agents/dream/agent.ts` — hardcoded model becomes provider-qualified.
- `test/settings.test.mjs` — update accepted/rejected settings tests.

**참조:** `src/settings.ts`, `src/agents/main.ts`, `src/agents/memory/agent.ts`,
`src/agents/dream/agent.ts`

**Verification:**
- [x] `pnpm build`
- [x] `pnpm test -- test/settings.test.mjs`

---

### Step 2: Provider Types And MCP Server Config Boundary

**`src/providers/types.ts`** (~70 LOC)

Remove Claude SDK type imports. Define provider-owned config types that can be
mapped to ACP.

```typescript
type ProviderConfig = {
  sessionKey: string;
  systemPrompt: string;
  model: string;
  tools?: string[];
  maxTurns?: number;
  cwd?: string;
  resume?: string;
  mcpServers?: AcpMcpServerConfig[];
};
```

**`src/agents/types.ts`** (~70 LOC)

Replace `McpServerConfig` from Claude SDK with a local ACP-compatible MCP server
type. `mcpServersFactory` should return an array or map that the ACP provider
can pass through as ACP `mcpServers`.

**`src/session/manager.ts`** (~210 LOC)

Keep the worker/interrupt logic intact, but include `sessionKey` and model
ownership in `createProviderConfig()`. Store writes must include the model.

**수정 파일:**
- `src/providers/types.ts`
- `src/agents/types.ts`
- `src/session/manager.ts`
- `src/session/types.ts`
- `test/session-manager.test.mjs`

**Verification:**
- [x] `pnpm test -- test/session-manager.test.mjs`

---

### Step 3: ACP Provider

**`src/providers/acp.ts`** (~350 LOC, new)

Implement `createAcpProviderFactory({ cwd })`.

Responsibilities:
- Parse `ProviderConfig.model`.
- Spawn the correct ACP agent subprocess for `anthropic/*`.
- Connect using `ClientSideConnection` and `ndJsonStream`.
- Initialize ACP once per provider session.
- Create, resume, or load the ACP session.
- Send text prompts with `session/prompt`.
- Collect `session/update` `agent_message_chunk` text and call `onMessage`.
- Map `interrupt()` to `session/cancel`.
- Close ACP session when supported, then close/kill the subprocess.

Implementation notes:
- Resolve `claude-agent-acp` without shelling through `npx`; prefer Node +
  resolved package path so daemon startup is deterministic.
- Pass the prompt through ACP `_meta.systemPrompt`.
- Pass Claude options through `_meta.claudeCode.options`, including `model`,
  `tools`, `maxTurns`, `cwd`, and any required env.
- Implement ACP client `requestPermission()` as non-interactive. It should
  select an allow option when the tool is within the configured tool set and
  reject otherwise. This preserves the bot's unattended runtime behavior.
- Ignore tool/plan/thought updates for user-facing text in the first migration;
  keep them available for debug logs if useful.
- Treat ACP `cancelled` as interruption rather than a user-visible error.

**`src/providers/claude.ts`**

Delete or replace this module with a small compatibility export only if needed
during the transition. The final runtime path should not call Claude SDK
`query()` directly.

**수정 파일:**
- `src/providers/acp.ts` — new ACP provider.
- `src/providers/claude.ts` — remove direct provider.
- `src/bot.ts`
- `src/commands/memory.ts`
- `src/commands/dream.ts`
- `test/*provider*.test.mjs` — add fake ACP provider tests.

**참조:** Existing provider contract in `src/providers/types.ts`; worker flow in
`src/session/manager.ts`; ACP SDK `ClientSideConnection` and `ndJsonStream`.

**Verification:**
- [x] Unit test fake ACP prompt flow.
- [x] Unit test cancel maps to ACP cancel.
- [x] Unit test process/JSON-RPC errors return provider errors.

---

### Step 4: ACP Session Persistence

**`src/session/store.ts`** (~180 LOC)

Add model ownership to persisted sessions.

```typescript
type PersistedSession = {
  sessionId: string;
  model: string;
  systemPrompt: string;
};
```

Schema changes:
- Add `model TEXT NOT NULL DEFAULT ''` to `sessions`.
- Bump `schema_version`.
- On existing databases, add the column but do not resume rows with `model = ''`.
- Disable or remove legacy `sessions.json` import for this migration.

Manager behavior:
- If stored `model` differs from current `agent.model`, ignore the stored
  session and create a new ACP session.
- If stored `model` matches, provider tries `session/resume`, then
  `session/load`, then `session/new`.
- Store the ACP session ID and model as soon as a session ID is known.

**수정 파일:**
- `src/session/store.ts`
- `src/session/types.ts`
- `src/session/manager.ts`
- `test/session-store.test.mjs`
- `test/session-manager.test.mjs`

**Verification:**
- [ ] Store round-trip includes `model`.
- [ ] Existing rows with empty model do not resume.
- [ ] Model mismatch creates a fresh provider session.

---

### Step 5: Restart Harness As Stdio MCP

**`src/agents/tools/restart-harness.ts`** (~120 LOC)

Keep shared constants and the tool business logic, but remove Claude SDK MCP
helpers. Expose a function that takes restart context and returns a plain tool
handler result.

**`src/mcp/restart-harness-server.ts`** (~180 LOC, new)

Create an executable stdio MCP server with `@modelcontextprotocol/sdk`.
It registers `restart_harness` and reads context from env:

```text
SKY_SESSION_KEY
SKY_SLACK_CHANNEL_ID
SKY_SLACK_THREAD_TS
SKY_PARENT_PID
```

The tool flow:
1. Validate env context.
2. Call existing `requestRestart()` from `src/runtime/pending-restart.ts`.
3. On success, signal `SKY_PARENT_PID` with a dedicated signal such as
   `SIGUSR2`.
4. Return the same brief instruction text used today.

**`src/bot.ts`** (~240 LOC)

Register a `SIGUSR2` handler that calls the existing restart scheduler. This
keeps the delayed `spawnDetachedRestart()` and self-`SIGTERM` behavior in the
bot process instead of the MCP subprocess.

**`src/agents/main.ts`** (~90 LOC)

Replace `createRestartHarnessServer()` usage with a stdio MCP server config.
Reuse `parseSessionKey()` to populate the env values. Keep
`mcp__sky__restart_harness` in the tool allowlist.

**수정 파일:**
- `src/agents/tools/restart-harness.ts`
- `src/mcp/restart-harness-server.ts` — new.
- `src/agents/main.ts`
- `src/bot.ts`
- `src/index.ts` or `package.json` bin/scripts if the MCP server needs a stable
  executable entrypoint.
- `test/restart-harness*.test.mjs`

**참조:** `src/runtime/pending-restart.ts`, `src/daemon.ts`,
`src/agents/main.ts`

**Verification:**
- [ ] Tool handler records pending restart.
- [ ] Parent signal schedules restart once.
- [ ] Existing restart rate limit still applies.

---

### Step 6: Runtime Integration And Documentation

**`README.md`** (~120 LOC touched)

Update language from direct Claude SDK long-lived `query()` to ACP sessions.
Document:
- top-level `model`;
- only `anthropic/*` supported in this migration;
- `claude-agent-acp` uses Claude authentication internally;
- ACP sessions persist in `~/.sky/sky.db`;
- `restart_harness` remains available.

**`src/index.ts`** (~40 LOC)

Update CLI description if it still says "Claude Agent SDK chatbot".

**수정 파일:**
- `README.md`
- `src/index.ts`
- Any startup log tests affected by settings text.

**Verification:**
- [ ] README examples match `settings.ts`.
- [ ] `pnpm build`

---

## File Summary

| File | Action | LOC |
|------|--------|-----|
| `package.json` | Modify dependencies/scripts | ~10 |
| `pnpm-lock.yaml` | Modify via pnpm | generated |
| `src/settings.ts` | Modify model config | ~80 |
| `src/providers/model.ts` | New model parser | ~80 |
| `src/providers/types.ts` | Modify provider boundary | ~70 |
| `src/providers/acp.ts` | New ACP provider | ~350 |
| `src/providers/claude.ts` | Delete or replace direct SDK provider | ~0-30 |
| `src/agents/types.ts` | Modify MCP config types | ~70 |
| `src/agents/main.ts` | Modify model/restart MCP config | ~90 |
| `src/agents/tools/restart-harness.ts` | Refactor shared tool logic | ~120 |
| `src/mcp/restart-harness-server.ts` | New stdio MCP server | ~180 |
| `src/session/store.ts` | Modify schema and persistence | ~180 |
| `src/session/manager.ts` | Modify model-aware resume config | ~210 |
| `src/session/types.ts` | Modify persisted session types | ~90 |
| `src/bot.ts` | Modify provider/settings/restart signal | ~240 |
| `src/commands/memory.ts` | Modify provider factory | ~40 |
| `src/commands/dream.ts` | Modify provider factory | ~70 |
| `src/agents/memory/agent.ts` | Modify model string | ~120 |
| `src/agents/dream/agent.ts` | Modify model strings | ~220 |
| `src/index.ts` | Modify CLI description | ~40 |
| `README.md` | Modify docs | ~120 touched |

---

## Testing Strategy

| Test File | Coverage | LOC |
|-----------|----------|-----|
| `test/settings.test.mjs` | top-level model, strict rejection of `claude`, invalid model strings | ~120 |
| `test/provider-model.test.mjs` | provider/model parser and unsupported providers | ~100 |
| `test/acp-provider.test.mjs` | fake ACP prompt flow, chunks, cancel, errors | ~250 |
| `test/session-store.test.mjs` | model column migration and round-trip | ~180 |
| `test/session-manager.test.mjs` | model-aware resume, mismatch fallback, store writes | ~350 |
| `test/restart-harness.test.mjs` | shared restart handler behavior and rate limit | ~180 |
| `test/restart-harness-mcp.test.mjs` | stdio MCP server env validation and tool call | ~220 |
| Existing memory/dream tests | unchanged behavior through provider boundary | existing |

Full gate:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Manual end-to-end verification:

- Configure `~/.sky/settings.json` with `model: "anthropic/claude-opus-4-7"`.
- Start `sky run` or the daemon and send a Slack or Telegram message.
- Restart the bot and confirm the new ACP session resumes from `sky.db`.
- Trigger `restart_harness` from Slack and confirm pending restart, daemon swap,
  and post-restart trigger delivery.
- Configure `model: "openai/gpt-5-5"` and confirm startup fails with a clear
  unsupported provider message.

## Progress Log

- 2026-05-04: Added ACP and MCP runtime dependencies; `pnpm typecheck` passed.
- 2026-05-04: Added provider-qualified model settings and parser; targeted settings/model tests passed.
- 2026-05-04: Removed Claude SDK types from shared provider/agent config and passed session keys into provider configs.
- 2026-05-04: Replaced the direct Claude provider with an ACP provider and covered prompt, cancel, resume fallback, and error paths.
