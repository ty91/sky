import {
  AuthStorage as PiAuthStorage,
  createAgentSession as piCreateAgentSession,
  DefaultResourceLoader as PiDefaultResourceLoader,
  getAgentDir as piGetAgentDir,
  ModelRegistry as PiModelRegistry,
  SessionManager as PiSessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import type { AgentConfig } from '../types.js';
import type {
  AgentSession,
  AgentSessionFactory,
  AgentToolSpec,
  CreateAgentSessionOptions,
} from './types.js';

type PiSession = Awaited<ReturnType<typeof piCreateAgentSession>>['session'];
type PiModelRegistryInstance = ReturnType<typeof PiModelRegistry.create>;
type PiBackendDeps = {
  AuthStorage: typeof PiAuthStorage;
  createAgentSession: typeof piCreateAgentSession;
  DefaultResourceLoader: typeof PiDefaultResourceLoader;
  getAgentDir: typeof piGetAgentDir;
  ModelRegistry: typeof PiModelRegistry;
  SessionManager: typeof PiSessionManager;
};

type PiContentBlock = {
  type?: unknown;
  text?: unknown;
};

type PiMessage = {
  role?: unknown;
  content?: unknown;
};

type PiSessionEvent = {
  type: string;
  message?: PiMessage;
  messages?: PiMessage[];
  willRetry?: boolean;
  assistantMessageEvent?: {
    type: string;
    delta?: unknown;
  };
};

const DEFAULT_PI_BACKEND_DEPS: PiBackendDeps = {
  AuthStorage: PiAuthStorage,
  createAgentSession: piCreateAgentSession,
  DefaultResourceLoader: PiDefaultResourceLoader,
  getAgentDir: piGetAgentDir,
  ModelRegistry: PiModelRegistry,
  SessionManager: PiSessionManager,
};

function resolveModel(modelRegistry: PiModelRegistryInstance, modelName: string) {
  const slash = modelName.indexOf('/');
  if (slash <= 0 || slash === modelName.length - 1) {
    throw new Error(`Invalid Pi model name: ${modelName}`);
  }

  const provider = modelName.slice(0, slash);
  const modelId = modelName.slice(slash + 1);
  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`Pi model not found: ${modelName}`);
  }
  return model;
}

function resolveSystemPrompt(agent: AgentConfig, usesStoredPromptSnapshot: boolean): string {
  if (usesStoredPromptSnapshot) {
    return agent.systemPrompt;
  }
  return agent.systemPromptLoader ? agent.systemPromptLoader() : agent.systemPrompt;
}

function toPiToolNames(tools: string[] | undefined): string[] | undefined {
  if (!tools) {
    return undefined;
  }

  const names = tools.map((tool) => {
    switch (tool) {
      case 'Bash':
        return 'bash';
      case 'Edit':
        return 'edit';
      case 'Find':
      case 'Glob':
        return 'find';
      case 'Grep':
        return 'grep';
      case 'Ls':
        return 'ls';
      case 'Read':
        return 'read';
      case 'Write':
        return 'write';
      default:
        return tool;
    }
  });
  return [...new Set(names)];
}

function extractPiTextDelta(event: PiSessionEvent): string | undefined {
  if (event.type !== 'message_update') {
    return undefined;
  }
  const assistantEvent = event.assistantMessageEvent;
  if (assistantEvent?.type !== 'text_delta' || typeof assistantEvent.delta !== 'string') {
    return undefined;
  }
  return assistantEvent.delta;
}

function extractPiMessageText(message: PiMessage | undefined): string {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => {
      const b = block as PiContentBlock;
      return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .join('');
}

function extractPiAssistantMessageText(event: PiSessionEvent): string | undefined {
  if (event.type !== 'message_end' || event.message?.role !== 'assistant') {
    return undefined;
  }
  const text = extractPiMessageText(event.message);
  return text.length > 0 ? text : undefined;
}

/**
 * The agent run finished. Pi's `agent_end` carries the full message list; the
 * final answer is the last assistant message. `willRetry` means another
 * `agent_end` will follow, so we only treat a non-retrying end as the turn end.
 */
function extractPiTurnEndText(event: PiSessionEvent): string | undefined {
  if (event.type !== 'agent_end' || event.willRetry) {
    return undefined;
  }
  const messages = event.messages;
  if (!Array.isArray(messages)) {
    return '';
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant') {
      return extractPiMessageText(messages[i]);
    }
  }
  return '';
}

export function toPiToolDefinition(spec: AgentToolSpec): ToolDefinition {
  return {
    name: spec.name,
    label: spec.label ?? spec.name,
    description: spec.description,
    parameters: z.toJSONSchema(z.object(spec.inputSchema)) as unknown as ToolDefinition['parameters'],
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      const result = await spec.execute(params);
      if (result.isError) {
        throw new Error(result.content.map((item) => item.text).join('\n'));
      }
      return {
        content: result.content,
        details: result.details,
      };
    },
  };
}

function toAgentSession(session: PiSession): AgentSession {
  return {
    sessionId: session.sessionId,
    ...(session.sessionFile ? { resumeRef: session.sessionFile } : {}),
    prompt: (text) => session.prompt(text),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
    subscribe: (listener) =>
      session.subscribe((event) => {
        const delta = extractPiTextDelta(event);
        if (delta !== undefined) {
          listener({ type: 'text_delta', delta });
          return;
        }
        const assistantText = extractPiAssistantMessageText(event);
        if (assistantText !== undefined) {
          listener({ type: 'assistant_message', text: assistantText });
          return;
        }
        const turnEndText = extractPiTurnEndText(event);
        if (turnEndText !== undefined) {
          listener({ type: 'turn_end', text: turnEndText });
        }
      }),
  };
}

export function createPiSessionFactoryWithDeps(
  deps: PiBackendDeps = DEFAULT_PI_BACKEND_DEPS,
): AgentSessionFactory {
  return Object.assign(
    async ({ key, agent, cwd, resume }: CreateAgentSessionOptions): Promise<AgentSession> => {
      const agentDir = deps.getAgentDir();
      const authStorage = deps.AuthStorage.create();
      const modelRegistry = deps.ModelRegistry.create(authStorage);
      const model = agent.model ? resolveModel(modelRegistry, agent.model) : undefined;
      const resourceLoader = new deps.DefaultResourceLoader({
        cwd,
        agentDir,
        systemPrompt: resolveSystemPrompt(agent, Boolean(resume?.resumeRef)),
        noContextFiles: true,
      });
      await resourceLoader.reload();
      const customTools = agent.customToolsFactory?.({ sessionKey: key }).map(toPiToolDefinition);
      const { session } = await deps.createAgentSession({
        cwd,
        agentDir,
        authStorage,
        modelRegistry,
        ...(model ? { model } : {}),
        ...(agent.effort ? { thinkingLevel: agent.effort } : {}),
        ...(agent.tools ? { tools: toPiToolNames(agent.tools) } : {}),
        ...(customTools ? { customTools } : {}),
        resourceLoader,
        sessionManager: resume?.resumeRef
          ? deps.SessionManager.open(resume.resumeRef, undefined, cwd)
          : deps.SessionManager.create(cwd),
      });
      return toAgentSession(session);
    },
    { backend: 'pi' as const },
  );
}

export const createPiSessionFactory: AgentSessionFactory = createPiSessionFactoryWithDeps();
