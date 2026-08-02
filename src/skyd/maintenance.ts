import { resolveAgentSessionFactory } from '../agents/backend/index.js';
import { runDreamAgent, dreamDailyFilePath } from '../agents/dream/agent.js';
import { runMemoryAgent } from '../agents/memory/agent.js';
import { createConversationManager } from '../conversation/manager.js';
import type { SkyHome } from '../sky-home.js';
import type { JsonlLogger } from './logger.js';
import { loadSecureSettings } from './settings.js';
import type { OperationRunner } from './operations.js';

export function createMaintenanceOperationRunner(
  skyHome: SkyHome,
  logger: JsonlLogger,
): OperationRunner {
  return async (request, context) => {
    const settings = loadSecureSettings(skyHome);
    logger.protect([
      settings.slack.botToken,
      settings.slack.appToken,
      settings.claudeAgentSdk?.oauthToken ?? '',
    ]);
    const createSession = resolveAgentSessionFactory(settings.agentBackend, {
      claudeCodeOauthToken: settings.claudeAgentSdk?.oauthToken,
    });
    const conversationManager = createConversationManager({
      defaultCwd: settings.workspace,
      createSession,
    });
    const abort = () => void conversationManager.closeAll();
    context.signal.addEventListener('abort', abort, { once: true });

    try {
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
      context.signal.removeEventListener('abort', abort);
      await conversationManager.closeAll();
    }
  };
}
