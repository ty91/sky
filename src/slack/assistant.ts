import { Assistant, type AssistantConfig } from '@slack/bolt';
import { TranscriptWriter } from '../agents/memory/transcript.js';
import type { AgentConfig } from '../agents/types.js';
import type { SessionManager } from '../session/manager.js';
import { downloadSlackFiles, formatAttachmentsLine, type SlackFile } from './files.js';
import { addReaction, removeReaction } from './reactions.js';
import { SlackSender } from './sender.js';
import { toThreadId } from './thread-id.js';

export type SlackAssistantOptions = {
  sessionManager: SessionManager;
  mainAgent: AgentConfig;
};

export const DEFAULT_SUGGESTED_PROMPTS = [
  { title: '오늘 할 일', message: '오늘 내가 해야 할 일을 정리해줘' },
  { title: '코드 리뷰', message: '최근 변경사항을 리뷰해줘' },
  { title: '아이디어 브레인스토밍', message: '새로운 기능 아이디어를 함께 생각해보자' },
] as const;

export function createSlackAssistantConfig(options: SlackAssistantOptions): AssistantConfig {
  const { sessionManager, mainAgent } = options;

  return {
    threadStarted: async ({ say, setSuggestedPrompts, saveThreadContext, event }) => {
      const channelId = event.assistant_thread.channel_id;
      const threadTs = event.assistant_thread.thread_ts;
      const threadId = toThreadId(channelId, threadTs);

      console.log(`[slack] assistant_thread_started: ${threadId}`);

      await say('안녕하세요! 무엇을 도와드릴까요?');
      await setSuggestedPrompts({
        prompts: [...DEFAULT_SUGGESTED_PROMPTS],
      });
      await saveThreadContext();
    },

    threadContextChanged: async ({ saveThreadContext }) => {
      await saveThreadContext();
    },

    userMessage: async ({ message, say, client }) => {
      const rawText = 'text' in message && typeof message.text === 'string' ? message.text.trim() : '';
      const channelId = message.channel;
      const threadTs = 'thread_ts' in message && typeof message.thread_ts === 'string'
        ? message.thread_ts
        : message.ts;
      const threadId = toThreadId(channelId, threadTs);

      // Handle file attachments
      const files = 'files' in message && Array.isArray(message.files) ? message.files as SlackFile[] : [];
      let attachmentsLine = '';

      if (files.length > 0) {
        console.log(`[slack] ${files.length} file(s) attached in ${threadId}`);
        const downloaded = await downloadSlackFiles(files, client);
        attachmentsLine = formatAttachmentsLine(downloaded);
      }

      const text = attachmentsLine
        ? [rawText, attachmentsLine].filter(Boolean).join('\n\n')
        : rawText;

      console.log(`[slack] user message in ${threadId}: ${JSON.stringify(text)}`);

      if (!text) {
        await say('빈 메시지는 처리할 수 없습니다.');
        return;
      }

      const messageTs = message.ts;

      const sender = new SlackSender({ say });
      const transcript = new TranscriptWriter(threadId);

      await addReaction(client, channelId, messageTs, 'thought_balloon');

      try {
        sessionManager.open(threadId, mainAgent);

        const resumedId = sessionManager.getSessionId(threadId);
        if (resumedId) {
          transcript.setSessionId(resumedId);
        }

        transcript.appendUser(text);

        const result = await sessionManager.send(threadId, text, {
          onMessage: async (msg) => {
            const sessionId = sessionManager.getSessionId(threadId);
            if (sessionId) {
              transcript.setSessionId(sessionId);
            }
            transcript.appendAssistant(msg);
            await sender.sendReply(msg);
          },
        });

        if (result.kind === 'interrupted') {
          await addReaction(client, channelId, messageTs, 'hand');
        } else if (result.kind === 'error') {
          throw result.error;
        } else {
          await addReaction(client, channelId, messageTs, 'white_check_mark');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[slack] error handling message in ${threadId}: ${errorMessage}`);
        await sender.sendReply(`오류가 났습니다: ${errorMessage}`);
      } finally {
        await removeReaction(client, channelId, messageTs, 'thought_balloon');
      }
    },
  };
}

export function createSlackAssistant(options: SlackAssistantOptions): Assistant {
  return new Assistant(createSlackAssistantConfig(options));
}
