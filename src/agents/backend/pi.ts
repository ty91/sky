import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager as PiSessionManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from '../types.js';
import type { AgentSession, AgentSessionFactory } from './types.js';

type PiSession = Awaited<ReturnType<typeof createAgentSession>>['session'];

type PiSessionEvent = {
  type: string;
  assistantMessageEvent?: {
    type: string;
    delta?: unknown;
  };
};

function resolveModel(modelRegistry: ModelRegistry, modelName: string) {
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
        }
      }),
  };
}

export const createPiSessionFactory: AgentSessionFactory = async ({ key, agent, cwd, resume }) => {
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = agent.model ? resolveModel(modelRegistry, agent.model) : undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPrompt: resolveSystemPrompt(agent, Boolean(resume?.resumeRef)),
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const customTools = agent.customToolsFactory?.({ sessionKey: key });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    ...(model ? { model } : {}),
    ...(agent.tools ? { tools: toPiToolNames(agent.tools) } : {}),
    ...(customTools ? { customTools } : {}),
    resourceLoader,
    sessionManager: resume?.resumeRef
      ? PiSessionManager.open(resume.resumeRef, undefined, cwd)
      : PiSessionManager.create(cwd),
  });
  return toAgentSession(session);
};
