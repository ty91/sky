import { createHash, randomBytes } from 'node:crypto';

const LOGIN_TOKEN_TTL_MS = 5 * 60 * 1_000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const TOKEN_BYTES = 32;

export type AdminLoginToken = {
  token: string;
  expiresAt: string;
};

export type AdminSession = {
  sessionId: string;
  csrfToken: string;
  expiresAt: string;
};

export type AuthenticatedAdminSession = Omit<AdminSession, 'sessionId'>;

export type AdminAuthentication = {
  issueLoginToken(): AdminLoginToken;
  exchangeLoginToken(token: string): AdminSession | undefined;
  authenticate(sessionId: string): AuthenticatedAdminSession | undefined;
};

export type AdminAuthenticationOptions = {
  now?: () => Date;
  protect?: (values: readonly string[]) => void;
};

type LoginTokenRecord = {
  expiresAtMs: number;
};

type SessionRecord = {
  csrfToken: string;
  expiresAtMs: number;
};

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function createToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function createAdminAuthentication(
  options: AdminAuthenticationOptions = {},
): AdminAuthentication {
  const now = options.now ?? (() => new Date());
  const loginTokens = new Map<string, LoginTokenRecord>();
  const sessions = new Map<string, SessionRecord>();

  const sweepExpired = (nowMs: number) => {
    for (const [key, record] of loginTokens) {
      if (record.expiresAtMs <= nowMs) loginTokens.delete(key);
    }
    for (const [key, record] of sessions) {
      if (record.expiresAtMs <= nowMs) sessions.delete(key);
    }
  };

  return {
    issueLoginToken() {
      const nowMs = now().getTime();
      sweepExpired(nowMs);
      let token: string;
      let key: string;
      do {
        token = createToken();
        key = digest(token);
      } while (loginTokens.has(key));
      const expiresAtMs = nowMs + LOGIN_TOKEN_TTL_MS;
      loginTokens.set(key, { expiresAtMs });
      options.protect?.([token]);
      return { token, expiresAt: new Date(expiresAtMs).toISOString() };
    },

    exchangeLoginToken(token) {
      if (!token) return undefined;
      const nowMs = now().getTime();
      sweepExpired(nowMs);
      const key = digest(token);
      const login = loginTokens.get(key);
      if (!login) return undefined;
      loginTokens.delete(key);

      let sessionId: string;
      let sessionKey: string;
      do {
        sessionId = createToken();
        sessionKey = digest(sessionId);
      } while (sessions.has(sessionKey));
      const csrfToken = createToken();
      const expiresAtMs = nowMs + SESSION_TTL_MS;
      sessions.set(sessionKey, { csrfToken, expiresAtMs });
      options.protect?.([sessionId, csrfToken]);
      return {
        sessionId,
        csrfToken,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },

    authenticate(sessionId) {
      if (!sessionId) return undefined;
      const nowMs = now().getTime();
      sweepExpired(nowMs);
      const session = sessions.get(digest(sessionId));
      if (!session) return undefined;
      return {
        csrfToken: session.csrfToken,
        expiresAt: new Date(session.expiresAtMs).toISOString(),
      };
    },
  };
}
