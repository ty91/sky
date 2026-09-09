import { MODEL_ALIAS_NAMES, resolveModelAlias, toModelDisplayName } from '../agents/models.js';
import type { ConversationManager } from '../conversation/manager.js';
import type { ThreadModelStore } from '../conversation/thread-model-store.js';
import type { SlackTurnReplyAdapter } from './turn.js';

export const CHAT_COMMAND_PREFIX = '!';

export const CHAT_COMMAND_USAGE = [
  '사용 가능한 명령어',
  `• \`!model <모델>\` — 이 스레드의 모델을 설정합니다 (첫 메시지에서만 가능). 사용 가능한 모델: ${MODEL_ALIAS_NAMES.join(', ')}`,
  '• `!help` — 이 도움말을 보여줍니다',
].join('\n');

export const CHAT_COMMAND_MODEL_LOCKED_REPLY =
  '이미 시작된 대화에서는 모델을 바꿀 수 없습니다. 새 스레드의 첫 메시지에서 `!model`을 사용해 주세요.';

export type ChatCommand = {
  name: string;
  args: string[];
};

/**
 * Recognises a chat command in a user message.
 *
 * Only a single-line message that starts with `!` counts, so multi-line prose
 * that happens to open with an exclamation mark still reaches the agent.
 */
export function parseChatCommand(rawText: string): ChatCommand | undefined {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith(CHAT_COMMAND_PREFIX) || trimmed.includes('\n')) {
    return undefined;
  }

  const [name, ...args] = trimmed.slice(CHAT_COMMAND_PREFIX.length).trim().split(/\s+/);
  if (!name) {
    return undefined;
  }

  return { name: name.toLowerCase(), args };
}

/**
 * Removes a leading bot mention label so `@sky !model fable` in a channel is
 * recognised the same way as a bare `!model fable` in a DM.
 */
export function stripLeadingMentionLabel(text: string, mentionLabel: string): string {
  const trimmed = text.trim();
  if (!mentionLabel || !trimmed.startsWith(mentionLabel)) {
    return trimmed;
  }

  const rest = trimmed.slice(mentionLabel.length);
  return rest === '' || /^\s/.test(rest) ? rest.trim() : trimmed;
}

export function formatUnknownCommandReply(name: string): string {
  return `알 수 없는 명령어입니다: \`${CHAT_COMMAND_PREFIX}${name}\`\n\n${CHAT_COMMAND_USAGE}`;
}

export function formatModelSetReply(model: string): string {
  return `모델이 ${toModelDisplayName(model)}로 설정되었습니다.`;
}

export type ChatCommandContext = {
  threadId: string;
  rawText: string;
  conversationManager: Pick<ConversationManager, 'has'>;
  threadModelStore: ThreadModelStore;
  reply: SlackTurnReplyAdapter;
};

/**
 * Handles a chat command if the message is one.
 *
 * Returns `true` when the message was consumed as a command (including error
 * and usage replies), meaning the caller must not run an agent turn.
 */
export async function maybeHandleChatCommand(ctx: ChatCommandContext): Promise<boolean> {
  const command = parseChatCommand(ctx.rawText);
  if (!command) {
    return false;
  }

  console.log(`[slack] chat command in ${ctx.threadId}: ${JSON.stringify(command)}`);

  if (command.name === 'help') {
    await ctx.reply.sendReply(CHAT_COMMAND_USAGE);
    return true;
  }

  if (command.name === 'model') {
    await handleModelCommand(ctx, command);
    return true;
  }

  await ctx.reply.sendReply(formatUnknownCommandReply(command.name));
  return true;
}

async function handleModelCommand(ctx: ChatCommandContext, command: ChatCommand): Promise<void> {
  if (command.args.length !== 1) {
    await ctx.reply.sendReply(CHAT_COMMAND_USAGE);
    return;
  }

  const model = resolveModelAlias(command.args[0]!);
  if (!model) {
    await ctx.reply.sendReply(
      `알 수 없는 모델입니다: \`${command.args[0]}\`\n\n${CHAT_COMMAND_USAGE}`,
    );
    return;
  }

  // A thread's model is fixed once its conversation exists — the backend
  // session cannot switch models mid-thread. `has` is called without an agent
  // so any existing session locks the thread, whatever model it runs.
  if (ctx.conversationManager.has(ctx.threadId) || ctx.threadModelStore.get(ctx.threadId)) {
    await ctx.reply.sendReply(CHAT_COMMAND_MODEL_LOCKED_REPLY);
    return;
  }

  ctx.threadModelStore.set(ctx.threadId, model);
  await ctx.reply.sendReply(formatModelSetReply(model));
}
