import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { App } from '../src/App';
import { overviewFixture } from './fixtures';
import { server } from './server';

function renderApp(route = '/') {
  window.history.replaceState(null, '', route);
  return render(<App />);
}

test('exchanges a fragment token, removes it from the URL, and opens the dashboard', async () => {
  let exchangedToken: string | undefined;
  server.use(
    http.post('/api/auth/exchange', async ({ request }) => {
      exchangedToken = ((await request.json()) as { token: string }).token;
      return HttpResponse.json({
        csrfToken: 'csrf-token',
        expiresAt: '2026-08-04T00:00:00.000Z',
      });
    }),
  );

  renderApp('/#token=one-time-token');

  expect(await screen.findByRole('status', { name: 'System status' })).toHaveTextContent(
    'All systems operational',
  );
  expect(exchangedToken).toBe('one-time-token');
  expect(window.location.hash).toBe('');
});

test('shows the full application shell and uses the real router', async () => {
  const user = userEvent.setup();
  renderApp();

  expect(await screen.findByText('taeyoung-mac')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  expect(screen.getByText('anthropic/claude-sonnet-4-5')).toBeInTheDocument();
  expect(screen.getByText('Workspace is readable and writable.')).toBeInTheDocument();

  await user.click(screen.getByRole('link', { name: 'Connections' }));
  expect(screen.getByRole('heading', { name: 'Connections' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/connections');
});

test('supports keyboard sign-in with a pasted one-time token', async () => {
  const user = userEvent.setup();
  let exchangedToken: string | undefined;
  server.use(
    http.get('/api/auth/session', () =>
      HttpResponse.json({ error: { code: 'session_required' } }, { status: 401 }),
    ),
    http.post('/api/auth/exchange', async ({ request }) => {
      exchangedToken = ((await request.json()) as { token: string }).token;
      return HttpResponse.json({
        csrfToken: 'csrf-token',
        expiresAt: '2026-08-04T00:00:00.000Z',
      });
    }),
  );
  renderApp();

  const tokenInput = await screen.findByRole('textbox', { name: 'One-time token' });
  await user.type(tokenInput, 'pasted-token');
  await user.tab();
  expect(screen.getByRole('button', { name: 'Sign in' })).toHaveFocus();
  await user.keyboard('{Enter}');

  expect(await screen.findByRole('status', { name: 'System status' })).toBeInTheDocument();
  expect(exchangedToken).toBe('pasted-token');
});

test('does not mistake an unreachable session endpoint for an expired session', async () => {
  const user = userEvent.setup();
  let requests = 0;
  server.use(
    http.get('/api/auth/session', () => {
      requests += 1;
      return requests === 1
        ? HttpResponse.error()
        : HttpResponse.json({
            csrfToken: 'csrf-token',
            expiresAt: '2026-08-04T00:00:00.000Z',
          });
    }),
  );
  renderApp();

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach Sky');
  expect(screen.queryByRole('heading', { name: 'Sign in to Sky' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Retry' }));

  expect(await screen.findByRole('status', { name: 'System status' })).toBeInTheDocument();
});

test('announces loading while the overview is pending', async () => {
  server.use(
    http.get('/api/overview', async () => {
      await delay('infinite');
      return HttpResponse.json(overviewFixture());
    }),
  );

  renderApp();

  expect(await screen.findByRole('status', { name: 'Loading dashboard' })).toBeInTheDocument();
});

test('surfaces degraded runtime and diagnostic details', async () => {
  server.use(
    http.get('/api/overview', () =>
      HttpResponse.json(
        overviewFixture({
          daemon: {
            ...overviewFixture().daemon,
            runtime: { state: 'degraded' },
            slack: {
              state: 'retrying',
              attempts: 2,
              nextRetryAt: '2026-08-03T01:03:00.000Z',
            },
          },
          diagnostics: {
            schemaVersion: 1,
            mode: 'daemon',
            overall: 'warn',
            checks: [
              {
                id: 'workspace.prompt.memory',
                status: 'warn',
                summary: 'MEMORY.md is missing.',
                detail: null,
                remediation: 'Create MEMORY.md in the workspace.',
              },
            ],
          },
        }),
      ),
    ),
  );

  renderApp();

  expect(await screen.findByRole('status', { name: 'System status' })).toHaveTextContent('Degraded');
  expect(screen.getByText('MEMORY.md is missing.')).toBeInTheDocument();
  expect(screen.getByText('Create MEMORY.md in the workspace.')).toBeInTheDocument();
});

test('recovers from an initial network error when the user retries', async () => {
  const user = userEvent.setup();
  let requests = 0;
  server.use(
    http.get('/api/overview', () => {
      requests += 1;
      return requests === 1 ? HttpResponse.error() : HttpResponse.json(overviewFixture());
    }),
  );
  renderApp();

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach Sky');
  await user.click(screen.getByRole('button', { name: 'Retry' }));

  expect(await screen.findByRole('status', { name: 'System status' })).toHaveTextContent(
    'All systems operational',
  );
});

test('returns to login when the session expires', async () => {
  server.use(
    http.get('/api/overview', () =>
      HttpResponse.json({ error: { code: 'session_required' } }, { status: 401 }),
    ),
  );
  renderApp();

  expect(await screen.findByRole('heading', { name: 'Sign in to Sky' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'One-time token' })).toBeInTheDocument();
});

test('distinguishes a lost daemon connection after the dashboard was loaded', async () => {
  const user = userEvent.setup();
  renderApp();
  expect(await screen.findByRole('status', { name: 'System status' })).toBeInTheDocument();

  server.use(http.get('/api/overview', () => HttpResponse.error()));
  await user.click(screen.getByRole('button', { name: 'Refresh dashboard' }));

  expect(await screen.findByRole('status', { name: 'Daemon connection' })).toHaveTextContent(
    'Reconnecting to the daemon',
  );
  expect(screen.getByRole('button', { name: 'Retry connection' })).toBeInTheDocument();
});
