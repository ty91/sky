export type SlackUserNameResolver = {
  getDisplayName(userId: string): Promise<string | undefined>;
};

export type SlackUsersInfoClient = {
  users: {
    info(params: { user: string }): Promise<unknown>;
  };
};

export function createCachedSlackUserNameResolver(client: SlackUsersInfoClient): SlackUserNameResolver {
  const cache = new Map<string, string | undefined>();

  return {
    async getDisplayName(userId) {
      const normalized = userId.trim();
      if (!normalized) {
        return undefined;
      }

      if (cache.has(normalized)) {
        return cache.get(normalized);
      }

      try {
        const response = await client.users.info({ user: normalized });
        const displayName = readSlackUserDisplayName(response);
        cache.set(normalized, displayName);
        return displayName;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[slack] users.info failed for ${normalized}: ${message}`);
        return undefined;
      }
    },
  };
}

export function formatSlackUserLabel(userId: string, displayName?: string): string {
  const normalizedUserId = userId.trim();
  const normalizedDisplayName = displayName?.trim();
  if (!normalizedUserId) {
    return normalizedDisplayName ?? 'UNKNOWN';
  }

  const mention = `<@${normalizedUserId}>`;
  return normalizedDisplayName ? `${normalizedDisplayName}(${mention})` : mention;
}

export function prefixSlackUserMessage(text: string, userId?: string, displayName?: string): string {
  const trimmedUserId = userId?.trim();
  if (!trimmedUserId) {
    return text;
  }

  return `${formatSlackUserLabel(trimmedUserId, displayName)}: ${text}`;
}

function readSlackUserDisplayName(response: unknown): string | undefined {
  if (!response || typeof response !== 'object' || !('user' in response)) {
    return undefined;
  }

  const user = response.user;
  if (!user || typeof user !== 'object') {
    return undefined;
  }

  const profile = 'profile' in user ? user.profile : undefined;
  const profileName = readFirstString(profile, ['display_name', 'real_name']);
  if (profileName) {
    return profileName;
  }

  return readFirstString(user, ['real_name', 'name']);
}

function readFirstString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  for (const key of keys) {
    if (key in value) {
      const field = (value as Record<string, unknown>)[key];
      if (typeof field === 'string' && field.trim()) {
        return field.trim();
      }
    }
  }

  return undefined;
}
