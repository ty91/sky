export function toThreadId(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}
