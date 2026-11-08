import { migrateTranscriptChats } from '../agents/memory/transcript-migration.js';
import type { SkyHome } from '../sky-home.js';
import { LEGACY_SLACK_PROVIDER, openConversationStore } from './store.js';

export function prepareConversationStorage(skyHome: SkyHome): void {
  const store = openConversationStore(skyHome);
  try {
    migrateTranscriptChats(
      skyHome,
      (chatId) => store.findByLink({ provider: LEGACY_SLACK_PROVIDER, externalId: chatId })?.id,
    );
  } finally {
    store.close();
  }
}
