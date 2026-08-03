export type Session = {
  csrfToken: string;
  expiresAt: string;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`Admin request failed with status ${status}.`);
  }
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      accept: 'application/json',
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    const details =
      payload && typeof payload === 'object' && 'error' in payload
        ? (payload.error as Record<string, unknown>)
        : {};
    throw new ApiError(response.status, details);
  }
  return payload as T;
}
