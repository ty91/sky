import { extractFromBunfs } from '@anthropic-ai/claude-agent-sdk/extract';
import { EMBEDDED_CLAUDE_CODE_EXECUTABLE } from './standalone-claude-helper-manifest.js';

export function createClaudeCodeExecutableResolver(
  embeddedPath: string | undefined,
  extract: (path: string) => string = extractFromBunfs,
): () => string | undefined {
  let extractedPath: string | undefined;
  return () => {
    if (embeddedPath === undefined) {
      return undefined;
    }

    extractedPath ??= extract(embeddedPath);
    return extractedPath;
  };
}

export const resolveClaudeCodeExecutable = createClaudeCodeExecutableResolver(
  EMBEDDED_CLAUDE_CODE_EXECUTABLE,
);
