import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { App } from '../src/App';
import { configurationFixture, overviewFixture, promptSnapshotFixture } from './fixtures';
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

test('shows agent configuration and distinguishes prompt file states', async () => {
  const user = userEvent.setup();
  renderApp('/agent');

  expect(await screen.findByRole('heading', { name: 'Agent settings' })).toBeInTheDocument();
  expect(screen.getByLabelText('Backend')).toHaveValue('pi');
  expect(screen.getByLabelText('Model')).toHaveValue('anthropic/claude-sonnet-4-5');
  expect(screen.getByText('# soul')).toBeInTheDocument();
  expect(screen.getByText('No workspace entry exists for this role.')).toBeInTheDocument();
  expect(screen.getByText('The symlink target is missing or cyclic.')).toBeInTheDocument();
  expect(
    screen.getByText('Content is hidden because the file exceeds the read limit.'),
  ).toBeInTheDocument();

  await user.click(screen.getByRole('link', { name: 'Dashboard' }));
  expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
});

test('saves settings with the revision and requests a protected graceful restart', async () => {
  const user = userEvent.setup();
  let patchRequest: { body: unknown; csrf: string | null } | undefined;
  let restartCsrf: string | null = null;
  server.use(
    http.patch('/api/configuration', async ({ request }) => {
      patchRequest = {
        body: await request.json(),
        csrf: request.headers.get('x-sky-csrf-token'),
      };
      return HttpResponse.json(
        configurationFixture({ revision: 3, activeRevision: 2, restartRequired: true }),
      );
    }),
    http.post('/api/restart', ({ request }) => {
      restartCsrf = request.headers.get('x-sky-csrf-token');
      return HttpResponse.json({ accepted: true }, { status: 202 });
    }),
  );
  renderApp('/agent');

  const model = await screen.findByLabelText('Model');
  await user.clear(model);
  await user.type(model, 'anthropic/claude-opus-4-7');
  await user.click(screen.getByRole('button', { name: 'Save configuration' }));

  expect(await screen.findByRole('status', { name: 'Restart required' })).toHaveTextContent(
    'Revision 3 is saved',
  );
  expect(patchRequest).toEqual({
    body: {
      expectedRevision: 2,
      patch: {
        agentBackend: 'pi',
        model: 'anthropic/claude-opus-4-7',
        effort: 'high',
        workspace: '/Users/taeyoung/.sky/workspace',
      },
    },
    csrf: 'csrf-token',
  });

  await user.click(screen.getByRole('button', { name: 'Graceful restart' }));
  expect(await screen.findByText(/Graceful restart requested/)).toBeInTheDocument();
  expect(restartCsrf).toBe('csrf-token');
});

test('loads the latest values after a revision conflict and lets the user reapply', async () => {
  const user = userEvent.setup();
  const revisions: number[] = [];
  server.use(
    http.patch('/api/configuration', async ({ request }) => {
      const body = (await request.json()) as { expectedRevision: number; patch: { model: string } };
      revisions.push(body.expectedRevision);
      if (revisions.length === 1) {
        return HttpResponse.json(
          {
            error: {
              code: 'revision_conflict',
              current: configurationFixture({
                revision: 3,
                settings: {
                  ...configurationFixture().settings,
                  model: 'anthropic/newer-model',
                },
              }),
            },
          },
          { status: 409 },
        );
      }
      return HttpResponse.json(
        configurationFixture({
          revision: 4,
          settings: {
            ...configurationFixture().settings,
            model: body.patch.model,
          },
        }),
      );
    }),
  );
  renderApp('/agent');

  await user.click(await screen.findByRole('button', { name: 'Save configuration' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('latest values are loaded');
  expect(screen.getByLabelText('Model')).toHaveValue('anthropic/newer-model');

  await user.click(screen.getByRole('button', { name: 'Save configuration' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Configuration saved');
  expect(revisions).toEqual([2, 3]);
});

test('recovers from an agent load error and a later save failure', async () => {
  const user = userEvent.setup();
  let configurationGets = 0;
  let saves = 0;
  server.use(
    http.get('/api/configuration', () => {
      configurationGets += 1;
      return configurationGets === 1
        ? HttpResponse.error()
        : HttpResponse.json(configurationFixture());
    }),
    http.get('/api/prompts', () => HttpResponse.json(promptSnapshotFixture())),
    http.patch('/api/configuration', () => {
      saves += 1;
      return saves === 1
        ? HttpResponse.json({ error: { code: 'internal_error' } }, { status: 500 })
        : HttpResponse.json(configurationFixture({ revision: 3 }));
    }),
  );
  renderApp('/agent');

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load agent settings');
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await user.click(await screen.findByRole('button', { name: 'Save configuration' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('was not saved');

  await user.click(screen.getByRole('button', { name: 'Save configuration' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Configuration saved');
  expect(saves).toBe(2);
});

test('announces loading while agent data is pending', async () => {
  server.use(
    http.get('/api/configuration', async () => {
      await delay('infinite');
      return HttpResponse.json(configurationFixture());
    }),
  );
  renderApp('/agent');

  expect(await screen.findByRole('status', { name: 'Loading agent settings' })).toBeInTheDocument();
});
