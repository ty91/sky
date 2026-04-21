import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

export type ProviderConfig = {
  systemPrompt: string;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  cwd?: string;
  resume?: string;
  /**
   * In-process MCP servers to expose to the underlying Claude Agent SDK
   * `query()` call. Values are typically produced by `createSdkMcpServer()`.
   */
  mcpServers?: Record<string, McpServerConfig>;
};

export type ProviderResult = {
  text: string;
  sessionId?: string;
};

export type CollectOptions = {
  onMessage?: (text: string) => Promise<void>;
};

export type ProviderSession = {
  send(text: string): Promise<void>;
  collect(options?: CollectOptions): Promise<ProviderResult>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
};

export type ProviderFactory = {
  create(config: ProviderConfig): ProviderSession;
};
