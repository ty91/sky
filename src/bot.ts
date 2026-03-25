import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BotRuntime } from './runtime/bot-runtime.js';
import { loadSettings } from './settings.js';

function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function loadSystemPrompt(workspace: string): string {
  const promptFiles = ['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md'] as const;
  const loaded: string[] = [];
  const missing: string[] = [];
  const promptParts: string[] = [];

  for (const file of promptFiles) {
    const content = safeRead(path.join(workspace, file));
    if (content) {
      loaded.push(file);
      promptParts.push(content);
    } else {
      missing.push(file);
    }
  }

  console.log(`[startup] prompt files loaded: ${loaded.join(', ') || '(none)'}`);
  if (missing.length > 0) {
    console.log(`[startup] prompt files missing: ${missing.join(', ')}`);
  }

  const combinedPrompt = promptParts.join('\n\n');
  console.log(`[startup] system prompt length: ${combinedPrompt.length} chars`);
  return combinedPrompt;
}

export async function startBot(): Promise<void> {
  console.log('[startup] loading settings...');
  const settings = loadSettings();
  console.log(`[startup] model: ${settings.claude.model}`);
  console.log(`[startup] workspace: ${settings.workspace}`);

  const runtime = new BotRuntime({
    settings,
    systemPrompt: loadSystemPrompt(settings.workspace),
  });

  await runtime.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startBot().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
