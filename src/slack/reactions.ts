export type ReactionsClient = {
  reactions: {
    add(params: { channel: string; name: string; timestamp: string }): Promise<unknown>;
    remove(params: { channel: string; name: string; timestamp: string }): Promise<unknown>;
  };
};

export async function addReaction(
  client: ReactionsClient,
  channel: string,
  timestamp: string,
  name: string,
): Promise<void> {
  try {
    console.log(`[slack] reactions.add(${name}) channel=${channel} ts=${timestamp}`);
    const result = await client.reactions.add({ channel, name, timestamp });
    console.log(`[slack] reactions.add(${name}) result: ${JSON.stringify(result)}`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes('already_reacted')) {
      console.error(`[slack] reactions.add(${name}) failed: ${msg}`);
    }
  }
}

export async function removeReaction(
  client: ReactionsClient,
  channel: string,
  timestamp: string,
  name: string,
): Promise<void> {
  try {
    await client.reactions.remove({ channel, name, timestamp });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes('no_reaction')) {
      console.error(`[slack] reactions.remove(${name}) failed: ${msg}`);
    }
  }
}
