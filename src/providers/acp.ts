import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type McpServer,
  type NewSessionRequest,
  type PromptRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { parseProviderModel } from './model.js';
import type {
  CollectOptions,
  ProviderConfig,
  ProviderFactory,
  ProviderMcpServerConfig,
  ProviderResult,
  ProviderSession,
} from './types.js';

type AcpProviderDefaults = {
  cwd: string;
  createAgentConnection?: (client: Client, runtime: AcpAgentRuntime) => AcpAgentConnection;
};

type AcpAgentRuntime = {
  command: string;
  args: string[];
};

type AcpAgentConnection = {
  initialize(): Promise<InitializeResponse>;
  newSession(params: NewSessionRequest): Promise<{ sessionId: string }>;
  resumeSession(params: NewSessionRequest & { sessionId: string }): Promise<unknown>;
  loadSession(params: NewSessionRequest & { sessionId: string }): Promise<unknown>;
  prompt(params: PromptRequest): Promise<{ stopReason: string }>;
  cancel(params: { sessionId: string }): Promise<void>;
  closeSession(params: { sessionId: string }): Promise<unknown>;
  close(): Promise<void>;
};

type AcpSessionState = {
  initialized?: InitializeResponse;
  sessionId?: string;
  pendingText?: string;
  finalText: string;
  streamText: string;
  streamOnMessage?: CollectOptions['onMessage'];
  closed: boolean;
};

async function flushStreamText(state: AcpSessionState): Promise<void> {
  const text = state.streamText;
  if (!text) {
    return;
  }

  state.streamText = '';
  await state.streamOnMessage?.(text);
}

function extractToolName(params: RequestPermissionRequest): string | undefined {
  const meta = params.toolCall._meta as
    | { claudeCode?: { toolName?: unknown } }
    | undefined;
  if (typeof meta?.claudeCode?.toolName === 'string') {
    return meta.claudeCode.toolName;
  }
  return params.toolCall.title ?? undefined;
}

function createClient(config: ProviderConfig, state: AcpSessionState): Client {
  return {
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const toolName = extractToolName(params);
      const allowed =
        !config.tools ||
        !toolName ||
        config.tools.includes(toolName) ||
        config.tools.some((name) => toolName.startsWith(`${name}(`));

      const option = params.options.find((item) =>
        allowed ? item.kind.startsWith('allow') : item.kind.startsWith('reject'),
      );

      if (!option) {
        return { outcome: { outcome: 'cancelled' } };
      }

      return {
        outcome: {
          outcome: 'selected',
          optionId: option.optionId,
        },
      };
    },

    async sessionUpdate(params: SessionNotification): Promise<void> {
      const update = params.update;
      if (update.sessionUpdate !== 'agent_message_chunk') {
        await flushStreamText(state);
        return;
      }
      if (update.content.type !== 'text') {
        return;
      }

      const text = update.content.text;
      state.finalText += text;
      state.streamText += text;
    },
  };
}

function isAcpMcpServer(value: ProviderMcpServerConfig): value is McpServer {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const server = value as Partial<McpServer>;
  if (typeof server.name !== 'string') {
    return false;
  }
  if ('type' in server && (server.type === 'http' || server.type === 'sse')) {
    return typeof server.url === 'string';
  }
  return typeof (server as { command?: unknown }).command === 'string';
}

function toAcpMcpServers(config: ProviderConfig): McpServer[] {
  const servers = config.mcpServers ? Object.values(config.mcpServers) : [];
  return servers.filter(isAcpMcpServer);
}

function buildClaudeSessionParams(config: ProviderConfig, defaults: AcpProviderDefaults): NewSessionRequest {
  const parsed = parseProviderModel(config.model);
  return {
    cwd: config.cwd ?? defaults.cwd,
    mcpServers: toAcpMcpServers(config),
    _meta: {
      systemPrompt: config.systemPrompt,
      claudeCode: {
        options: {
          model: parsed.modelId,
          maxTurns: config.maxTurns,
          tools: config.tools,
          settingSources: [],
          env: {
            ...process.env,
            CLAUDE_AGENT_SDK_CLIENT_APP: 'sky/0.5.0',
          },
          extraArgs: {
            'replay-user-messages': '',
          },
        },
      },
    },
  };
}

function buildCodexSessionParams(config: ProviderConfig, defaults: AcpProviderDefaults): NewSessionRequest {
  return {
    cwd: config.cwd ?? defaults.cwd,
    mcpServers: toAcpMcpServers(config),
  };
}

function buildSessionParams(config: ProviderConfig, defaults: AcpProviderDefaults): NewSessionRequest {
  const parsed = parseProviderModel(config.model);
  if (parsed.provider === 'anthropic') {
    return buildClaudeSessionParams(config, defaults);
  }
  return buildCodexSessionParams(config, defaults);
}

function resolveClaudeAgentAcpPath(): string {
  return fileURLToPath(import.meta.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js'));
}

function resolveCodexAgentAcpPath(): string {
  const platformPackages: Partial<Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, string>>>> = {
    darwin: {
      arm64: '@zed-industries/codex-acp-darwin-arm64',
      x64: '@zed-industries/codex-acp-darwin-x64',
    },
    linux: {
      arm64: '@zed-industries/codex-acp-linux-arm64',
      x64: '@zed-industries/codex-acp-linux-x64',
    },
    win32: {
      arm64: '@zed-industries/codex-acp-win32-arm64',
      x64: '@zed-industries/codex-acp-win32-x64',
    },
  };
  const packageName = platformPackages[process.platform]?.[process.arch];
  if (!packageName) {
    throw new Error(`Unsupported Codex ACP platform: ${process.platform}/${process.arch}`);
  }

  const binaryName = process.platform === 'win32' ? 'codex-acp.exe' : 'codex-acp';
  const codexAcpWrapperPath = fileURLToPath(
    import.meta.resolve('@zed-industries/codex-acp/bin/codex-acp.js'),
  );
  const requireFromCodexAcp = createRequire(codexAcpWrapperPath);
  return requireFromCodexAcp.resolve(`${packageName}/bin/${binaryName}`);
}

function formatTomlValue(value: string): string {
  return JSON.stringify(value);
}

function buildCodexAgentArgs(config: ProviderConfig, modelId: string): string[] {
  return [
    '-c',
    `model=${formatTomlValue(modelId)}`,
    '-c',
    `developer_instructions=${formatTomlValue(config.systemPrompt)}`,
    '-c',
    'project_doc_max_bytes=0',
  ];
}

function resolveAcpAgentRuntime(config: ProviderConfig): AcpAgentRuntime {
  const parsed = parseProviderModel(config.model);
  if (parsed.provider === 'anthropic') {
    return {
      command: process.execPath,
      args: [resolveClaudeAgentAcpPath()],
    };
  }

  return {
    command: resolveCodexAgentAcpPath(),
    args: buildCodexAgentArgs(config, parsed.modelId),
  };
}

function createProcessConnection(client: Client, runtime: AcpAgentRuntime): AcpAgentConnection {
  const child = spawn(runtime.command, runtime.args, {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  if (!child.stdin || !child.stdout) {
    throw new Error('Failed to open ACP agent stdio pipes');
  }

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = new ClientSideConnection(() => client, stream);

  return {
    initialize: () =>
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'sky', version: '0.1.0' },
        clientCapabilities: {},
      }),
    newSession: (params) => connection.newSession(params),
    resumeSession: (params) => connection.resumeSession(params),
    loadSession: (params) => connection.loadSession(params),
    prompt: (params) => connection.prompt(params),
    cancel: (params) => connection.cancel(params),
    closeSession: (params) => connection.closeSession(params),
    close: async () => {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
      await Promise.race([
        connection.closed.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    },
  };
}

async function ignoreFailure(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

function createAcpSession(config: ProviderConfig, defaults: AcpProviderDefaults): ProviderSession {
  parseProviderModel(config.model);
  const state: AcpSessionState = {
    sessionId: config.resume,
    finalText: '',
    streamText: '',
    closed: false,
  };
  const client = createClient(config, state);
  const runtime = resolveAcpAgentRuntime(config);
  const agent = defaults.createAgentConnection
    ? defaults.createAgentConnection(client, runtime)
    : createProcessConnection(client, runtime);

  async function ensureInitialized(): Promise<InitializeResponse> {
    if (!state.initialized) {
      state.initialized = await agent.initialize();
    }
    return state.initialized;
  }

  async function ensureSession(): Promise<string> {
    await ensureInitialized();

    const sessionParams = buildSessionParams(config, defaults);
    if (state.sessionId) {
      const params = { ...sessionParams, sessionId: state.sessionId };
      const resumed = await ignoreFailure(() => agent.resumeSession(params));
      if (resumed) {
        return state.sessionId;
      }

      const loaded = await ignoreFailure(() => agent.loadSession(params));
      if (loaded) {
        return state.sessionId;
      }

      state.sessionId = undefined;
    }

    const session = await agent.newSession(sessionParams);
    state.sessionId = session.sessionId;
    return state.sessionId;
  }

  return {
    async send(text: string): Promise<void> {
      if (state.closed) {
        throw new Error('ACP provider session is closed');
      }
      state.pendingText = text;
    },

    async collect(options?: CollectOptions): Promise<ProviderResult> {
      const text = state.pendingText;
      if (!text) {
        return { text: '(No response)', sessionId: state.sessionId };
      }

      state.pendingText = undefined;
      state.finalText = '';
      state.streamText = '';
      state.streamOnMessage = options?.onMessage;

      try {
        const sessionId = await ensureSession();
        const response = await agent.prompt({
          sessionId,
          prompt: [{ type: 'text', text }],
        });

        if (response.stopReason === 'cancelled') {
          throw new Error('ACP prompt was cancelled');
        }
        if (response.stopReason !== 'end_turn') {
          throw new Error(`ACP prompt stopped: ${response.stopReason}`);
        }

        await flushStreamText(state);
        const finalText = state.finalText || '(No text response)';

        return {
          text: finalText,
          sessionId,
        };
      } finally {
        state.streamOnMessage = undefined;
        state.streamText = '';
      }
    },

    async interrupt(): Promise<void> {
      const sessionId = state.sessionId;
      if (!sessionId) {
        return;
      }
      await agent.cancel({ sessionId });
    },

    async close(): Promise<void> {
      state.closed = true;
      if (state.sessionId) {
        await ignoreFailure(() => agent.closeSession({ sessionId: state.sessionId! }));
      }
      await agent.close();
    },
  };
}

export function createAcpProviderFactory(defaults: AcpProviderDefaults): ProviderFactory {
  return {
    create(config: ProviderConfig): ProviderSession {
      return createAcpSession(config, defaults);
    },
  };
}
