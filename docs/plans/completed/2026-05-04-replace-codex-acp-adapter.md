---
title: Replace Codex ACP Adapter
type: refactor
status: completed
created_at: 2026-05-04T12:22:16Z
---

# Replace Codex ACP Adapter

## Context

`sky` currently supports `openai/*` models through `@zed-industries/codex-acp`. That adapter is launched as a platform-specific `codex-acp` binary and receives Codex settings through CLI `-c` overrides. The replacement target, `@agentclientprotocol/codex-acp`, exposes a Node bin at `dist/index.js`, starts an ACP stdio server, and internally launches Codex CLI in `app-server` mode.

This plan replaces the Codex ACP adapter while preserving Sky's existing provider boundary, Slack session flow, ACP lifecycle, and persisted session behavior.

### Scope

**포함:**
- Replace the npm dependency from `@zed-industries/codex-acp` to `@agentclientprotocol/codex-acp` with `pnpm`.
- Update the `openai/*` ACP runtime resolver to launch the new Node-based adapter.
- Move Codex settings from CLI `-c` args to `CODEX_CONFIG` JSON.
- Preserve the minimal OpenAI `NewSessionRequest` shape without Claude metadata.
- Update focused runtime/env tests and README provider documentation.

**제외:**
- Changing the user-facing `model` setting format.
- Adding provider-specific settings such as `providers.openai`.
- Implementing client-driven ACP authentication UI flows.
- Changing Slack rendering for Codex tool calls, model state, modes, or quota metadata.

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
Shared ACP client/runtime
      |
      +-- anthropic/* -> node @agentclientprotocol/claude-agent-acp/dist/index.js
      |
      +-- openai/*    -> node @agentclientprotocol/codex-acp/dist/index.js
                            |
                            v
                         codex app-server
```

The shared ACP path in `src/providers/acp.ts` remains responsible for initialize, session creation/resume/load, prompt streaming, cancellation, and close. Provider-specific code stays limited to runtime resolution, environment construction, and `NewSessionRequest` construction.

The new `@agentclientprotocol/codex-acp` adapter reads `CODEX_CONFIG`, optionally honors `CODEX_PATH`, and invokes Codex as `codex app-server` internally. Sky should let the adapter resolve its bundled `@openai/codex/bin/codex.js` unless the user already set `CODEX_PATH`.

---

## Implementation Steps

### Step 0: Dependency

Use the package manager to replace the adapter dependency.

```bash
pnpm remove @zed-industries/codex-acp
pnpm add @agentclientprotocol/codex-acp
```

**수정 파일:**
- `package.json` — replace the Codex ACP dependency.
- `pnpm-lock.yaml` — update lockfile entries for `@agentclientprotocol/codex-acp` and its dependencies, including `@openai/codex`.

**Verification:**
- [x] `pnpm install --frozen-lockfile`

---

### Step 1: Resolve The New Codex ACP Runtime

**`src/providers/acp.ts`** (~420 LOC after changes)

Remove the current platform package map and `createRequire`-based resolution for `@zed-industries/codex-acp-*`.

Add a resolver for the new adapter:

```typescript
function resolveCodexAgentAcpPath(): string {
  return fileURLToPath(import.meta.resolve('@agentclientprotocol/codex-acp/dist/index.js'));
}
```

Update the `openai` branch in `resolveAcpAgentRuntime()` to launch the adapter with Node:

```typescript
return {
  command: process.execPath,
  args: [resolveCodexAgentAcpPath()],
  env: buildCodexAgentEnv(config, parsed.modelId),
};
```

Remove `formatTomlValue()` and `buildCodexAgentArgs()`, because the new adapter does not use CLI `-c` overrides.

**참조:**
- `src/providers/acp.ts` — current `resolveCodexAgentAcpPath()`, `buildCodexAgentArgs()`, and `resolveAcpAgentRuntime()`.
- `/Users/taeyoung/Developer/oss/codex-acp-agentclientprotocol/src/index.ts` — upstream reads `CODEX_CONFIG` and `CODEX_PATH`.
- `/Users/taeyoung/Developer/oss/codex-acp-agentclientprotocol/src/CodexJsonRpcConnection.ts` — upstream launches Codex with `app-server`.

**Verification:**
- [x] Unit test asserts `openai/*` runtime uses `process.execPath`.
- [x] Unit test asserts the runtime arg points at `@agentclientprotocol/codex-acp/dist/index.js`.

---

### Step 2: Pass Codex Settings Through `CODEX_CONFIG`

**`src/providers/acp.ts`** (~420 LOC after changes)

Keep the explicit Codex subprocess env allowlist. Extend it for the new adapter where needed:

```typescript
const CODEX_ENV_KEYS = [
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_HOME',
  'CODEX_PATH',
  'APP_SERVER_LOGS',
  'MODEL_PROVIDER',
  // existing home, XDG, PATH, temp, proxy, cert, and RUST_LOG keys
] as const;
```

Change `buildCodexAgentEnv()` to accept the provider config and model id. After copying allowlisted values, set:

```typescript
env.CODEX_CONFIG = JSON.stringify({
  model: modelId,
  developer_instructions: config.systemPrompt,
  project_doc_max_bytes: 0,
});
```

Do not set `DEFAULT_AUTH_REQUEST` for API key injection. Existing Codex auth channels remain the supported path: Codex/ChatGPT login, `CODEX_API_KEY`, or `OPENAI_API_KEY`.

**참조:**
- `src/bot.ts` — `loadSystemPrompt()` assembles the workspace prompt that becomes `ProviderConfig.systemPrompt`.
- `src/session/manager.ts` — persists the resolved prompt snapshot used for session resume.
- `/Users/taeyoung/Developer/oss/codex-acp-agentclientprotocol/src/CodexAcpClient.ts` — upstream merges `CODEX_CONFIG` into Codex session config.

**Verification:**
- [x] Unit test parses `runtime.env.CODEX_CONFIG` and asserts `model`, `developer_instructions`, and `project_doc_max_bytes`.
- [x] Unit test confirms allowlisted auth/path env keys are copied when present.
- [x] Unit test confirms unrelated env secrets are not copied.

---

### Step 3: Preserve OpenAI Session Params

**`src/providers/acp.ts`** (~420 LOC after changes)

Keep `buildCodexSessionParams()` minimal:

```typescript
return {
  cwd: config.cwd ?? defaults.cwd,
  mcpServers: toAcpMcpServers(config),
};
```

Do not add `_meta.claudeCode`, Claude tools, `maxTurns`, `settingSources`, or Claude `extraArgs` to OpenAI sessions. The new adapter converts ACP `mcpServers` into Codex app-server config internally.

**Verification:**
- [x] Existing test still asserts OpenAI sessions omit Claude metadata.
- [x] Existing MCP server filtering behavior remains covered by provider tests or existing config paths.

---

### Step 4: Update Tests And Documentation

**`test/acp-provider.test.mjs`** (~330 LOC after changes)

Update `ACP provider selects Codex ACP runtime for openai models`:

- Assert `runtime.command === process.execPath`.
- Assert `runtime.args` contains only the resolved `dist/index.js` adapter path.
- Parse and assert `runtime.env.CODEX_CONFIG`.
- Add env fixture coverage for `CODEX_API_KEY`, `CODEX_HOME`, and `CODEX_PATH` alongside `OPENAI_API_KEY`.
- Keep the assertion that `SKY_SECRET_FOR_TEST` is not copied.

**`README.md`** (~105 LOC after changes)

Update the OpenAI provider documentation:

- Replace `@zed-industries/codex-acp` with `@agentclientprotocol/codex-acp`.
- Mention that `openai/*` runs through Codex `app-server` via the adapter.
- Preserve the existing authentication guidance for Codex/ChatGPT login, `CODEX_API_KEY`, and `OPENAI_API_KEY`.

**Verification:**
- [x] `pnpm build`
- [x] `pnpm typecheck`
- [x] `node --test test/acp-provider.test.mjs`
- [x] `pnpm test`

---

## File Summary

| File | Action | LOC |
|------|--------|-----|
| `package.json` | Modify | ~1 |
| `pnpm-lock.yaml` | Modify | package-manager generated |
| `src/providers/acp.ts` | Modify | ~420 |
| `test/acp-provider.test.mjs` | Modify | ~330 |
| `README.md` | Modify | ~105 |

---

## Testing Strategy

| Test File | Coverage | LOC |
|-----------|----------|-----|
| `test/acp-provider.test.mjs` | Codex runtime command/args, `CODEX_CONFIG`, env allowlist, OpenAI session params, existing ACP lifecycle regressions | ~330 |

Run the full project gate before handoff:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

For end-to-end smoke verification after unit tests pass, configure `~/.sky/settings.json` with `model: "openai/gpt-5.5"`, ensure Codex auth is available through login or environment, run `pnpm dev` or `sky run`, and send a Slack Assistant DM thread prompt. Confirm that the response streams back and that the same Slack thread resumes the same ACP session.

## Progress Log

- 2026-05-04: Replaced the Codex ACP dependency with `@agentclientprotocol/codex-acp` and verified the lockfile with `pnpm install --frozen-lockfile`.
- 2026-05-04: Updated the OpenAI runtime resolver to launch `@agentclientprotocol/codex-acp/dist/index.js` with Node and verified `node --test test/acp-provider.test.mjs`.
- 2026-05-04: Added `CODEX_CONFIG` runtime env construction and expanded the Codex env allowlist, verified with `pnpm build` and `node --test test/acp-provider.test.mjs`.
- 2026-05-04: Confirmed OpenAI session params remain minimal and omit Claude metadata with `node --test test/acp-provider.test.mjs`.
- 2026-05-04: Updated README provider documentation for `@agentclientprotocol/codex-acp` and verified with `pnpm build`, `pnpm typecheck`, `node --test test/acp-provider.test.mjs`, and `pnpm test`.
- 2026-05-04: Implementation completed.
