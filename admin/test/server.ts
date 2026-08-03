import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { overviewFixture } from './fixtures';

export const handlers = [
  http.get('/api/auth/session', () =>
    HttpResponse.json({
      csrfToken: 'csrf-token',
      expiresAt: '2026-08-04T00:00:00.000Z',
    }),
  ),
  http.post('/api/auth/exchange', () =>
    HttpResponse.json({
      csrfToken: 'csrf-token',
      expiresAt: '2026-08-04T00:00:00.000Z',
    }),
  ),
  http.get('/api/overview', () => HttpResponse.json(overviewFixture())),
];

export const server = setupServer(...handlers);
