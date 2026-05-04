export type AcpStdioMcpServerConfig = {
  type?: 'stdio';
  name: string;
  command: string;
  args: string[];
  env?: { name: string; value: string }[];
};

export type AcpHttpMcpServerConfig = {
  type: 'http';
  name: string;
  url: string;
  headers?: { name: string; value: string }[];
};

export type AcpSseMcpServerConfig = {
  type: 'sse';
  name: string;
  url: string;
  headers?: { name: string; value: string }[];
};

export type ProviderMcpServerConfig =
  | AcpStdioMcpServerConfig
  | AcpHttpMcpServerConfig
  | AcpSseMcpServerConfig
  | Record<string, unknown>;

export type ProviderConfig = {
  sessionKey: string;
  systemPrompt: string;
  model: string;
  tools?: string[];
  maxTurns?: number;
  cwd?: string;
  resume?: string;
  mcpServers?: Record<string, ProviderMcpServerConfig>;
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
