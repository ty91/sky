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

type PiSessionEvent = {
  type: string;
  message?: {
    role?: unknown;
  };
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

function isPiAssistantMessageEnd(event: PiSessionEvent): boolean {
  return event.type === 'message_end' && event.message?.role === 'assistant';
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
        if (isPiAssistantMessageEnd(event)) {
          listener({ type: 'message_end' });
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
