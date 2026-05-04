export type ParsedModel = {
  provider: 'anthropic' | 'openai';
  modelId: string;
  raw: string;
};

export function parseProviderModel(value: string): ParsedModel {
  const separatorIndex = value.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error(`Model must use "<provider>/<model>" format (got: ${value})`);
  }

  const provider = value.slice(0, separatorIndex);
  const modelId = value.slice(separatorIndex + 1);

  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new Error(`Unsupported model provider: ${provider}`);
  }

  return {
    provider,
    modelId,
    raw: value,
  };
}
