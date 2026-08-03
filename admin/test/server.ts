import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { configurationFixture, overviewFixture, promptSnapshotFixture } from './fixtures';

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
  http.get('/api/configuration', () => HttpResponse.json(configurationFixture())),
  http.patch('/api/configuration', async ({ request }) => {
    const body = (await request.json()) as { expectedRevision: number };
    return HttpResponse.json(
      configurationFixture({
        revision: body.expectedRevision + 1,
        activeRevision: body.expectedRevision,
        restartRequired: true,
      }),
    );
  }),
  http.get('/api/prompts', () => HttpResponse.json(promptSnapshotFixture())),
  http.post('/api/restart', () => HttpResponse.json({ accepted: true }, { status: 202 })),
];

export const server = setupServer(...handlers);
