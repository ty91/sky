import type { ConversationLink } from '../conversation/types.js';

export const SLACK_THREAD_LINK_PROVIDER = 'slack';

export type SlackThread = {
  channelId: string;
  threadTs: string;
};

export function toThreadId(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

export function slackThreadLink(channelId: string, threadTs: string): ConversationLink {
  return { provider: SLACK_THREAD_LINK_PROVIDER, externalId: toThreadId(channelId, threadTs) };
}

export function readSlackThreadLink(links: readonly ConversationLink[]): SlackThread | undefined {
  const link = links.find((candidate) => candidate.provider === SLACK_THREAD_LINK_PROVIDER);
  if (!link) return undefined;
  const separator = link.externalId.indexOf(':');
  if (separator <= 0 || separator === link.externalId.length - 1) return undefined;
  return {
    channelId: link.externalId.slice(0, separator),
    threadTs: link.externalId.slice(separator + 1),
  };
}
