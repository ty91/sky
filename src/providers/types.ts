export type ProviderConfig = {
  systemPrompt: string;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  cwd?: string;
  resume?: string;
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
  close(): Promise<void>;
};

export type ProviderFactory = {
  create(config: ProviderConfig): ProviderSession;
};
