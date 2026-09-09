import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  configurationFixture,
  connectionsFixture,
  logHistoryFixture,
  overviewFixture,
  promptSnapshotFixture,
  scheduledJobsFixture,
  sessionsFixture,
  systemFixture,
} from './fixtures';

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
  http.get('/api/system', () => HttpResponse.json(systemFixture())),
  http.get('/api/logs', () => HttpResponse.json(logHistoryFixture())),
  http.get('/api/configuration', () => HttpResponse.json(configurationFixture())),
  http.get('/api/connections', () => HttpResponse.json(connectionsFixture())),
  http.post('/api/connections/check', () => HttpResponse.json(connectionsFixture())),
  http.put('/api/secrets/:name', () =>
    HttpResponse.json(configurationFixture({ restartRequired: true })),
  ),
  http.delete('/api/secrets/:name', () =>
    HttpResponse.json(configurationFixture({ restartRequired: true })),
  ),
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
  http.get('/api/sessions', () => HttpResponse.json(sessionsFixture())),
  http.delete('/api/sessions/:threadKey', () => HttpResponse.json({ reset: true })),
  http.get('/api/scheduler/jobs', () => HttpResponse.json(scheduledJobsFixture())),
  http.delete('/api/scheduler/jobs/:jobId', () => HttpResponse.json({ cancelled: true })),
  http.post('/api/restart', () => HttpResponse.json({ accepted: true }, { status: 202 })),
];

export const server = setupServer(...handlers);
