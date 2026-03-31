import { App } from '@slack/bolt';
import type { AgentConfig } from '../agents/types.js';
import type { SessionManager } from '../session/manager.js';
import { createSlackAssistant } from './assistant.js';

export type SlackAppOptions = {
  botToken: string;
  appToken: string;
  sessionManager: SessionManager;
  mainAgent: AgentConfig;
};

export async function startSlackApp(options: SlackAppOptions): Promise<App> {
  const app = new App({
    token: options.botToken,
    appToken: options.appToken,
    socketMode: true,
  });

  const assistant = createSlackAssistant({
    sessionManager: options.sessionManager,
    mainAgent: options.mainAgent,
  });

  app.assistant(assistant);

  await app.start();
  console.log('[slack] bolt app started (socket mode)');

  return app;
}

export async function stopSlackApp(app: App): Promise<void> {
  try {
    await app.stop();
    console.log('[slack] bolt app stopped');
  } catch (error) {
    console.error(`[slack] error stopping app: ${error instanceof Error ? error.message : String(error)}`);
  }
}
