import { Assistant, type AssistantConfig } from '@slack/bolt';
import { TranscriptWriter } from '../agents/memory/transcript.js';
import type { AgentConfig } from '../agents/types.js';
import {
  getPersistedSessionId,
  type SessionManager,
} from '../session/manager.js';
import { downloadSlackFiles, formatAttachmentsLine, type SlackFile } from './files.js';
import { SlackSender } from './sender.js';

// ── Reaction helpers ──

type ReactionsClient = {
  reactions: {
    add(params: { channel: string; name: string; timestamp: string }): Promise<unknown>;
    remove(params: { channel: string; name: string; timestamp: string }): Promise<unknown>;
  };
};

async function addReaction(client: ReactionsClient, channel: string, timestamp: string, name: string): Promise<void> {
  try {
    console.log(`[slack] reactions.add(${name}) channel=${channel} ts=${timestamp}`);
    const result = await client.reactions.add({ channel, name, timestamp });
    console.log(`[slack] reactions.add(${name}) result: ${JSON.stringify(result)}`);
  } catch (error: unknown) {
    // already_reacted is harmless — ignore it, log everything else
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes('already_reacted')) {
      console.error(`[slack] reactions.add(${name}) failed: ${msg}`);
    }
  }
}

async function removeReaction(client: ReactionsClient, channel: string, timestamp: string, name: string): Promise<void> {
  try {
    await client.reactions.remove({ channel, name, timestamp });
  } catch (error: unknown) {
    // no_reaction means it was already removed — harmless
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes('no_reaction')) {
      console.error(`[slack] reactions.remove(${name}) failed: ${msg}`);
    }
  }
}

export type SlackAssistantOptions = {
  sessionManager: SessionManager;
  mainAgent: AgentConfig;
};

export const DEFAULT_SUGGESTED_PROMPTS = [
  { title: '오늘 할 일', message: '오늘 내가 해야 할 일을 정리해줘' },
  { title: '코드 리뷰', message: '최근 변경사항을 리뷰해줘' },
  { title: '아이디어 브레인스토밍', message: '새로운 기능 아이디어를 함께 생각해보자' },
] as const;

export function toThreadId(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

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

    userMessage: async ({ message, say, setStatus, client }) => {
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

      const sender = new SlackSender({
        say,
        setStatus: (status) => setStatus(status),
      });
      const transcript = new TranscriptWriter(threadId);
      const resume = getPersistedSessionId(threadId);

      if (resume) {
        transcript.setSessionId(resume);
      }

      await addReaction(client, channelId, messageTs, 'thought_balloon');
      await sender.setStatus('생각 중...');

      try {
        sessionManager.open(threadId, mainAgent, { resume });
        transcript.appendUser(text);

        const result = await sessionManager.send(threadId, text, {
          onMessage: async (msg) => {
            const sessionId = sessionManager.getSessionId(threadId);
            if (sessionId) {
              transcript.setSessionId(sessionId);
            }
            transcript.appendAssistant(msg);
            await sender.sendReply(msg);
            await sender.setStatus('생각 중...');
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
        await sender.setStatus('');
      }
    },
  };
}

export function createSlackAssistant(options: SlackAssistantOptions): Assistant {
  return new Assistant(createSlackAssistantConfig(options));
}
