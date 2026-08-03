import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  createSdkMcpServer as sdkCreateSdkMcpServer,
  query as sdkQuery,
  tool as sdkTool,
  type Options as ClaudeOptions,
  type Query as ClaudeQuery,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentConfig } from '../types.js';
import { Pushable } from '../../session/pushable.js';
import {
  claudeDebugQueryOptions,
  startClaudeQueryAttempt,
  type ClaudeQueryDiagnostics,
} from './claude-observability.js';
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionFactory,
  AgentToolResult,
  AgentToolSpec,
  CreateAgentSessionOptions,
} from './types.js';

const CLAUDE_MCP_SERVER_NAME = 'sky';
const CLAUDE_MODEL_PROVIDER = 'anthropic';

// Rechecked against @anthropic-ai/claude-agent-sdk 0.3.201 sdk-tools.d.ts.
// Main-agent tools TaskOutput, TaskStop, TodoWrite, and Skill are supported in
// this version; Agent is an SDK feature outside Options.tools and is
// intentionally filtered from this adapter's built-in tool allowlist.
const SUPPORTED_CLAUDE_BUILTIN_TOOLS = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Skill',
  'TodoWrite',
  'TaskOutput',
  'TaskStop',
  'NotebookEdit',
  'ListMcpResources',
  'ReadMcpResource',
  'ReadMcpResourceDir',
]);

type ClaudeAgentSdkDeps = {
  query: typeof sdkQuery;
  createSdkMcpServer: typeof sdkCreateSdkMcpServer;
  tool: typeof sdkTool;
  env?: NodeJS.ProcessEnv;
  diagnostics?: ClaudeQueryDiagnostics;
};

type ActiveTurn = {
  query: ClaudeQuery;
  input: Pushable<SDKUserMessage>;
  observation: ReturnType<typeof startClaudeQueryAttempt>;
  interrupted: boolean;
};

type ToolSelection = {
  builtins?: string[];
  allowed?: string[];
};

function resolveSystemPrompt(agent: AgentConfig): string {
  return agent.systemPromptLoader ? agent.systemPromptLoader() : agent.systemPrompt;
}

function resolveSessionSystemPrompt(agent: AgentConfig, resume: CreateAgentSessionOptions['resume']): string {
  if (resume) {
    return resume.systemPrompt || agent.systemPrompt;
  }
  return resolveSystemPrompt(agent);
}

function resolveClaudeModel(modelName: string | undefined): string | undefined {
  if (!modelName) {
    return undefined;
  }

  const slash = modelName.indexOf('/');
  if (slash <= 0 || slash === modelName.length - 1) {
    throw new Error(`Invalid Claude Agent SDK model name: ${modelName}`);
  }

  const provider = modelName.slice(0, slash);
  if (provider !== CLAUDE_MODEL_PROVIDER) {
    throw new Error(
      `Unsupported Claude Agent SDK model provider: ${provider}. Expected ${CLAUDE_MODEL_PROVIDER}.`,
    );
  }

  return modelName.slice(slash + 1);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function toMcpToolName(name: string): string {
  return `mcp__${CLAUDE_MCP_SERVER_NAME}__${name}`;
}

function resolveSkyPlugin(cwd: string): NonNullable<ClaudeOptions['plugins']> | undefined {
  const pluginPath = path.join(cwd, '.agents');
  if (
    !existsSync(path.join(pluginPath, 'skills')) &&
    !existsSync(path.join(pluginPath, '.claude-plugin', 'plugin.json'))
  ) {
    return undefined;
  }

  return [{ type: 'local', path: pluginPath, skipMcpDiscovery: true }];
}

function resolveToolSelection(
  tools: string[] | undefined,
  customToolNames: Set<string>,
): ToolSelection {
  if (!tools) {
    return {};
  }

  const builtins: string[] = [];
  const allowed: string[] = [];

  for (const name of tools) {
    if (SUPPORTED_CLAUDE_BUILTIN_TOOLS.has(name)) {
      builtins.push(name);
      if (name !== 'Skill') {
        allowed.push(name);
      }
      continue;
    }

    if (customToolNames.has(name)) {
      allowed.push(toMcpToolName(name));
    }
  }

  return {
    builtins: unique(builtins),
    allowed: unique(allowed),
  };
}

function toStructuredContent(details: unknown): Record<string, unknown> | undefined {
  if (details === undefined) {
    return undefined;
  }
  if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
    return details as Record<string, unknown>;
  }
  return { details };
}

function toCallToolResult(result: AgentToolResult): CallToolResult {
  return {
    content: result.content,
    ...(result.details !== undefined ? { structuredContent: toStructuredContent(result.details) } : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
}

function toSdkTool(spec: AgentToolSpec, deps: ClaudeAgentSdkDeps) {
  return deps.tool(spec.name, spec.description, spec.inputSchema, async (args) =>
    toCallToolResult(await spec.execute(args)),
  );
}

function extractClaudeTextDelta(message: SDKMessage): string | undefined {
  if (message.type !== 'stream_event') {
    return undefined;
  }

  const event = message.event as {
    type?: unknown;
    delta?: {
      type?: unknown;
      text?: unknown;
    };
  };

  if (
    event.type === 'content_block_delta' &&
    event.delta?.type === 'text_delta' &&
    typeof event.delta.text === 'string'
  ) {
    return event.delta.text;
  }

  return undefined;
}

function extractClaudeAssistantText(message: SDKMessage): string | undefined {
  if (message.type !== 'assistant') {
    return undefined;
  }

  const content = (message.message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((block) => {
      const b = block as { type?: unknown; text?: unknown };
      return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .join('');
  return text.length > 0 ? text : undefined;
}

function formatResultError(message: SDKMessage): Error | undefined {
  if (message.type !== 'result' || message.subtype === 'success') {
    return undefined;
  }

  const details =
    'errors' in message && Array.isArray(message.errors) && message.errors.length > 0
      ? `: ${message.errors.join('\n')}`
      : '';
  return new Error(`Claude Agent SDK query failed (${message.subtype})${details}`);
}

function isEdeDiagnostic(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('[ede_diagnostic]');
}

function resolveClaudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    throw new Error(
      'CLAUDE_CODE_OAUTH_TOKEN is required for the Claude Agent SDK backend. Run `claude setup-token` and provide the token in the daemon environment.',
    );
  }

  const resolved: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'ANTHROPIC_API_KEY') {
      continue;
    }
    resolved[key] = value;
  }
  resolved.CLAUDE_CODE_OAUTH_TOKEN = token;
  return resolved;
}

class ClaudeAgentSdkSession implements AgentSession {
  private sessionIdValue: string;
  private activeTurn?: ActiveTurn;
  private disposed = false;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private readonly customTools: AgentToolSpec[];
  private readonly customToolNames: Set<string>;
  private readonly mcpServer: ReturnType<typeof sdkCreateSdkMcpServer>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly systemPromptValue: string;

  constructor(
    private readonly options: CreateAgentSessionOptions,
    private readonly deps: ClaudeAgentSdkDeps,
  ) {
    this.sessionIdValue = options.resume?.sessionId ?? '';
    this.customTools = options.agent.customToolsFactory?.({ sessionKey: options.key }) ?? [];
    this.customToolNames = new Set(this.customTools.map((toolSpec) => toolSpec.name));
    this.mcpServer = deps.createSdkMcpServer({
      name: CLAUDE_MCP_SERVER_NAME,
      tools: this.customTools.map((toolSpec) => toSdkTool(toolSpec, deps)),
    });
    this.env = resolveClaudeEnv(deps.env ?? process.env);
    this.systemPromptValue = resolveSessionSystemPrompt(options.agent, options.resume);
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  get resumeRef(): undefined {
    return undefined;
  }

  get systemPrompt(): string {
    return this.systemPromptValue;
  }

  async prompt(text: string): Promise<void> {
    if (this.disposed) {
      throw new Error('Claude Agent SDK session has been disposed.');
    }
    if (this.activeTurn) {
      throw new Error('Claude Agent SDK session already has an active turn.');
    }

    const input = new Pushable<SDKUserMessage>();
    const observation = startClaudeQueryAttempt({
      diagnostics: this.deps.diagnostics,
      purpose: 'conversation_turn',
      cwd: this.options.cwd,
      env: this.env,
    });
    let query: ClaudeQuery;
    try {
      query = this.deps.query({
        prompt: input,
        options: this.createQueryOptions(),
      });
      observation.queryCreated();
    } catch (error) {
      observation.failed(error);
      throw error;
    }
    const turn: ActiveTurn = {
      query,
      input,
      observation,
      interrupted: false,
    };
    this.activeTurn = turn;

    let resultError: Error | undefined;

    try {
      input.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      });
      observation.inputEnqueued();

      for await (const message of query) {
        observation.sdkMessage(message);
        if (message.type === 'system' && message.subtype === 'init') {
          this.sessionIdValue = message.session_id;
          continue;
        }

        const delta = extractClaudeTextDelta(message);
        if (delta !== undefined) {
          this.emit({ type: 'text_delta', delta });
          continue;
        }

        const assistantText = extractClaudeAssistantText(message);
        if (assistantText !== undefined) {
          this.emit({ type: 'assistant_message', text: assistantText });
          continue;
        }

        if (message.type === 'result') {
          input.end();
          if (turn.interrupted) {
            continue;
          }
          resultError = formatResultError(message);
          if (!resultError && message.subtype === 'success') {
            this.emit({ type: 'turn_end', text: message.result });
          }
        }
      }
      observation.completed();
    } catch (error) {
      observation.failed(error);
      if (turn.interrupted && isEdeDiagnostic(error)) {
        return;
      }
      throw error;
    } finally {
      input.end();
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
    }

    if (resultError) {
      throw resultError;
    }
  }

  async abort(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }

    turn.interrupted = true;
    turn.observation.aborted();
    try {
      await turn.query.interrupt();
    } catch (error) {
      turn.input.end();
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    const turn = this.activeTurn;
    if (turn) {
      turn.interrupted = true;
      turn.observation.aborted();
      turn.input.end();
      turn.query.close();
    }
    this.listeners.clear();
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private createQueryOptions(): ClaudeOptions {
    const toolSelection = resolveToolSelection(this.options.agent.tools, this.customToolNames);

    // Per TY-6 verification, per-turn query has no idle subprocess, but each active
    // turn spawns about 330 MB RSS and pays about 200 ms spawn overhead. A manager
    // concurrency cap is intentionally out of this slice's scope.
    return {
      cwd: this.options.cwd,
      systemPrompt: this.systemPromptValue,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      settings: {
        disableBundledSkills: true,
      },
      plugins: resolveSkyPlugin(this.options.cwd),
      skills: 'all',
      strictMcpConfig: true,
      includePartialMessages: true,
      thinking: { type: 'adaptive' },
      env: this.env,
      ...claudeDebugQueryOptions(this.deps.diagnostics),
      mcpServers: {
        [CLAUDE_MCP_SERVER_NAME]: this.mcpServer,
      },
      ...(this.options.agent.model ? { model: resolveClaudeModel(this.options.agent.model) } : {}),
      ...(this.options.agent.effort ? { effort: this.options.agent.effort } : {}),
      ...(this.options.agent.maxTurns !== undefined ? { maxTurns: this.options.agent.maxTurns } : {}),
      ...(toolSelection.builtins !== undefined ? { tools: toolSelection.builtins } : {}),
      ...(toolSelection.allowed !== undefined ? { allowedTools: toolSelection.allowed } : {}),
      ...(this.sessionIdValue ? { resume: this.sessionIdValue } : {}),
    };
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

const DEFAULT_SDK_DEPS: ClaudeAgentSdkDeps = {
  query: sdkQuery,
  createSdkMcpServer: sdkCreateSdkMcpServer,
  tool: sdkTool,
};

export function createClaudeAgentSdkSessionFactory(
  deps: Partial<ClaudeAgentSdkDeps> = {},
): AgentSessionFactory {
  const resolvedDeps: ClaudeAgentSdkDeps = { ...DEFAULT_SDK_DEPS, ...deps };
  return Object.assign(
    async (options: CreateAgentSessionOptions) => new ClaudeAgentSdkSession(options, resolvedDeps),
    { backend: 'claude-agent-sdk' as const },
  );
}

export const createDefaultClaudeAgentSdkSessionFactory = createClaudeAgentSdkSessionFactory();
