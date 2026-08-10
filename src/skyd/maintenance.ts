import { resolveAgentSessionFactory } from '../agents/backend/index.js';
import { runDreamAgent, dreamDailyFilePath } from '../agents/dream/agent.js';
import { runMemoryAgent } from '../agents/memory/agent.js';
import { createConversationManager } from '../conversation/manager.js';
import type { Configuration } from '../configuration.js';
import type { SkyHome } from '../sky-home.js';
import type { JsonlLogger } from './logger.js';
import type { OperationRunner } from './operations.js';
import type { ClaudeQueryDiagnostics } from '../agents/backend/claude-observability.js';
import type { AgentSessionFactory } from '../agents/backend/types.js';

export type MaintenanceOperationRunnerOptions = {
  claudeDiagnostics?: ClaudeQueryDiagnostics;
  createSession?: AgentSessionFactory;
};

export function createMaintenanceOperationRunner(
  skyHome: SkyHome,
  logger: JsonlLogger,
  configuration: Configuration,
  options: MaintenanceOperationRunnerOptions = {},
): OperationRunner {
  return async (request, context) => {
    const settings = configuration.resolveRuntime().settings;
    logger.protect([
      settings.slack.botToken,
      settings.slack.appToken,
      settings.claudeAgentSdk?.oauthToken ?? '',
    ]);
    const createSession =
      options.createSession ??
      resolveAgentSessionFactory(settings.agentBackend, {
        claudeCodeOauthToken: settings.claudeAgentSdk?.oauthToken,
        claudeDiagnostics: options.claudeDiagnostics,
      });
    const conversationManager = createConversationManager({
      defaultCwd: settings.workspace,
      createSession,
    });
    let closing: Promise<void> | undefined;
    const closeAll = () => (closing ??= conversationManager.closeAll());
    const abort = () => void closeAll();
    if (context.signal.aborted) abort();
    else context.signal.addEventListener('abort', abort, { once: true });

    try {
      if (context.signal.aborted) {
        throw new Error('Maintenance operation was aborted before it started.');
      }
      if (request.type === 'memory') {
        context.progress('Running working-memory update.');
        return await runMemoryAgent({
          conversationManager,
          workspace: settings.workspace,
          skyHome,
        });
      }

      context.progress('Running daily dream update.');
      const result = await runDreamAgent({
        conversationManager,
        workspace: settings.workspace,
        targetDate: request.date,
        onlyStep: request.step,
        transcriptsDir: skyHome.transcriptsDir,
      });
      return {
        ...result,
        dailyFile: dreamDailyFilePath(settings.workspace, result.targetDate),
      };
    } finally {
      await closing;
      await conversationManager.closeAll();
      context.signal.removeEventListener('abort', abort);
    }
  };
}
