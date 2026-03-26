import { Assistant, type AssistantConfig } from '@slack/bolt';
import type { ClaudeSessionManager } from '../session/manager.js';
import { SlackSender } from './sender.js';

export type SlackAssistantOptions = {
  sessionManager: ClaudeSessionManager;
};

function toThreadId(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

export function createSlackAssistant(options: SlackAssistantOptions): Assistant {
  const { sessionManager } = options;

  const config: AssistantConfig = {
    threadStarted: async ({ say, setSuggestedPrompts, event }) => {
      const channelId = event.assistant_thread.channel_id;
      const threadTs = event.assistant_thread.thread_ts;
      const threadId = toThreadId(channelId, threadTs);

      console.log(`[slack] assistant_thread_started: ${threadId}`);

      await say('안녕하세요! 무엇을 도와드릴까요?');
      await setSuggestedPrompts({
        prompts: [
          { title: '오늘 할 일', message: '오늘 내가 해야 할 일을 정리해줘' },
          { title: '코드 리뷰', message: '최근 변경사항을 리뷰해줘' },
          { title: '아이디어 브레인스토밍', message: '새로운 기능 아이디어를 함께 생각해보자' },
        ],
      });
    },

    threadContextChanged: async ({ saveThreadContext }) => {
      await saveThreadContext();
    },

    userMessage: async ({ message, say, setStatus, setTitle }) => {
      const text = 'text' in message && typeof message.text === 'string' ? message.text.trim() : '';
      const channelId = message.channel;
      const threadTs = 'thread_ts' in message && typeof message.thread_ts === 'string'
        ? message.thread_ts
        : message.ts;
      const threadId = toThreadId(channelId, threadTs);

      console.log(`[slack] user message in ${threadId}: ${JSON.stringify(text)}`);

      if (!text) {
        await say('빈 메시지는 처리할 수 없습니다.');
        return;
      }

      const sender = new SlackSender({
        say,
        setStatus: (status) => setStatus(status),
      });

      await sender.setStatus('생각하는 중...');

      try {
        // 첫 메시지로 스레드 제목 설정
        const titleText = text.length > 40 ? `${text.slice(0, 40)}...` : text;
        await setTitle(titleText).catch(() => {
          // setTitle은 best-effort
        });

        const result = await sessionManager.handleText(threadId, text);

        if (result.kind === 'busy') {
          await sender.sendReply('지금 이전 요청을 처리 중입니다. 잠시 후 다시 보내주세요.');
          return;
        }

        await sender.sendReply(result.reply);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[slack] error handling message in ${threadId}: ${errorMessage}`);
        await sender.sendReply(`오류가 났습니다: ${errorMessage}`);
      }
    },
  };

  return new Assistant(config);
}
