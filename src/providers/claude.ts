import { randomUUID } from 'node:crypto';
import {
  query,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { Pushable } from '../session/pushable.js';
import type {
  CollectOptions,
  ProviderConfig,
  ProviderFactory,
  ProviderResult,
  ProviderSession,
} from './types.js';

type ClaudeProviderDefaults = {
  cwd: string;
};

type ClaudeSessionState = {
  input: Pushable<SDKUserMessage>;
  runner: Query;
  sessionId?: string;
  pendingPromptUuid?: string;
};

function buildUserMessage(text: string): SDKUserMessage {
  const promptUuid = randomUUID();
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
    session_id: promptUuid,
    parent_tool_use_id: null,
    uuid: promptUuid,
  };
}

function buildOptions(config: ProviderConfig, defaults: ClaudeProviderDefaults): Options {
  return {
    model: config.model,
    cwd: config.cwd ?? defaults.cwd,
    systemPrompt: config.systemPrompt,
    maxTurns: config.maxTurns,
    ...(config.resume ? { resume: config.resume } : {}),
    ...(config.mcpServers ? { mcpServers: config.mcpServers as Options['mcpServers'] } : {}),
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'sky/0.5.0',
    },
    tools: config.tools,
    permissionMode: 'bypassPermissions' as PermissionMode,
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    ...({ extraArgs: { 'replay-user-messages': '' } } as unknown as {}),
  };
}

function extractTextFromMessage(message: SDKMessage): string {
  if (message.type !== 'assistant') return '';

  const blocks = message.message.content ?? [];
  const texts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      texts.push(block.text);
    }
  }

  return texts.join('\n').trim();
}

function isSystemInitMessage(message: SDKMessage): message is SDKSystemMessage {
  return message.type === 'system' && (message as SDKSystemMessage).subtype === 'init';
}

function isPromptReplay(message: SDKMessage, promptUuid: string): boolean {
  return message.type === 'user' && 'uuid' in message && message.uuid === promptUuid;
}

async function collectResult(
  state: ClaudeSessionState,
  options?: CollectOptions,
): Promise<ProviderResult> {
  const promptUuid = state.pendingPromptUuid;

  if (!promptUuid) {
    return {
      text: '(No response)',
      sessionId: state.sessionId,
    };
  }

  let finalText = '';
  let promptReplayed = false;

  while (true) {
    const { value: message, done } = await state.runner.next();

    if (done || !message) {
      break;
    }

    if (isSystemInitMessage(message)) {
      state.sessionId = message.session_id;
      continue;
    }

    if (isPromptReplay(message, promptUuid)) {
      promptReplayed = true;
      continue;
    }

    if (message.type === 'assistant') {
      const text = extractTextFromMessage(message);
      if (!text) {
        continue;
      }

      finalText = text;
      if (options?.onMessage) {
        await options.onMessage(text);
      }
      continue;
    }

    if (message.type === 'result') {
      if (!promptReplayed) {
        continue;
      }

      state.pendingPromptUuid = undefined;

      if (message.subtype === 'success') {
        return {
          text: finalText || message.result || '(No text response)',
          sessionId: state.sessionId ?? message.session_id,
        };
      }

      throw new Error(message.errors.join('; ') || 'Claude returned an error');
    }
  }

  state.pendingPromptUuid = undefined;
  return {
    text: finalText || '(No response)',
    sessionId: state.sessionId,
  };
}

function createClaudeSession(
  config: ProviderConfig,
  defaults: ClaudeProviderDefaults,
): ProviderSession {
  const input = new Pushable<SDKUserMessage>();
  const state: ClaudeSessionState = {
    input,
    runner: query({
      prompt: input,
      options: buildOptions(config, defaults),
    }),
    sessionId: config.resume,
  };

  return {
    async send(text: string): Promise<void> {
      const message = buildUserMessage(text);
      state.pendingPromptUuid = message.uuid;
      state.input.push(message);
    },
    async collect(options?: CollectOptions): Promise<ProviderResult> {
      return await collectResult(state, options);
    },
    async interrupt(): Promise<void> {
      state.pendingPromptUuid = undefined;
      await state.runner.interrupt();
    },
    async close(): Promise<void> {
      state.input.end();
      state.runner.close();
    },
  };
}

export function createClaudeProviderFactory(defaults: ClaudeProviderDefaults): ProviderFactory {
  return {
    create(config: ProviderConfig): ProviderSession {
      return createClaudeSession(config, defaults);
    },
  };
}
