import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { App } from '../src/App';
import {
  configurationFixture,
  connectionsFixture,
  overviewFixture,
  promptSnapshotFixture,
  scheduledJobsFixture,
} from './fixtures';
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

test('lists safe session metadata and requires confirmation before reset', async () => {
  const user = userEvent.setup();
  let resetRequest: { threadKey: string; csrf: string | null } | undefined;
  server.use(
    http.delete('/api/sessions/:threadKey', ({ params, request }) => {
      resetRequest = {
        threadKey: String(params.threadKey),
        csrf: request.headers.get('x-sky-csrf-token'),
      };
      return HttpResponse.json({ reset: true });
    }),
  );
  renderApp('/sessions');

  expect(await screen.findByText('pi-session-1')).toBeInTheDocument();
  expect(screen.getByText('anthropic/claude-sonnet-4-5')).toBeInTheDocument();
  expect(screen.queryByText(/resume/i)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Reset session D123:1777901000.000000' }));

  expect(resetRequest).toBeUndefined();
  expect(screen.getByRole('alertdialog')).toHaveTextContent('active or pending turn will stop');
  await user.click(screen.getByRole('button', { name: 'Confirm reset' }));

  expect(resetRequest).toEqual({
    threadKey: 'D123:1777901000.000000',
    csrf: 'csrf-token',
  });
  expect(await screen.findByText('No sessions')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('was reset');
});

test('recovers from a sessions error into the empty state', async () => {
  const user = userEvent.setup();
  let requests = 0;
  server.use(
    http.get('/api/sessions', async () => {
      requests += 1;
      if (requests === 1) {
        return HttpResponse.json({ error: { code: 'runtime_unavailable' } }, { status: 503 });
      }
      await delay(20);
      return HttpResponse.json({ sessions: [] });
    }),
  );
  renderApp('/sessions');

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load sessions');
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(screen.getByRole('status', { name: 'Loading sessions' })).toBeInTheDocument();
  expect(await screen.findByText('No sessions')).toBeInTheDocument();
});

test('lists scheduler state and only cancels a confirmed pending job', async () => {
  const user = userEvent.setup();
  let cancelRequest: { jobId: string; csrf: string | null } | undefined;
  server.use(
    http.delete('/api/scheduler/jobs/:jobId', ({ params, request }) => {
      cancelRequest = {
        jobId: String(params.jobId),
        csrf: request.headers.get('x-sky-csrf-token'),
      };
      return HttpResponse.json({ cancelled: true });
    }),
  );
  renderApp('/scheduler');

  expect(await screen.findByRole('heading', { name: 'Pack passport' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Daily review' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Only pending jobs can be cancelled' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Cancel job Pack passport' }));

  expect(cancelRequest).toBeUndefined();
  expect(screen.getByRole('alertdialog')).toHaveTextContent('Only a job that is still pending');
  await user.click(screen.getByRole('button', { name: 'Confirm cancel' }));

  expect(cancelRequest).toEqual({ jobId: 'job-pending', csrf: 'csrf-token' });
  expect(await screen.findByRole('status')).toHaveTextContent('was cancelled');
  expect(screen.getAllByRole('button', { name: 'Only pending jobs can be cancelled' })).toHaveLength(2);
});

test('announces loading while scheduler data is pending', async () => {
  server.use(
    http.get('/api/scheduler/jobs', async () => {
      await delay('infinite');
      return HttpResponse.json(scheduledJobsFixture());
    }),
  );
  renderApp('/scheduler');

  expect(await screen.findByRole('status', { name: 'Loading scheduled jobs' })).toBeInTheDocument();
});

test('keeps credential values write-only and makes keep, replace, and delete explicit', async () => {
  const user = userEvent.setup();
  let putRequest: { body: unknown; csrf: string | null } | undefined;
  server.use(
    http.put('/api/secrets/:name', async ({ request, params }) => {
      expect(params.name).toBe('slack.botToken');
      putRequest = {
        body: await request.json(),
        csrf: request.headers.get('x-sky-csrf-token'),
      };
      return HttpResponse.json(configurationFixture({ restartRequired: true }));
    }),
  );
  renderApp('/connections');

  const heading = await screen.findByRole('heading', { name: 'Slack bot token' });
  const card = heading.closest('article');
  expect(card).not.toBeNull();
  expect(within(card!).getByText('xoxb-…test')).toBeInTheDocument();
  expect(within(card!).queryByLabelText('New Slack bot token')).not.toBeInTheDocument();
  expect(within(card!).getByRole('radio', { name: 'Keep' })).toBeChecked();

  await user.click(within(card!).getByRole('button', { name: 'Apply keep' }));
  expect(await screen.findByText('The current credential was kept unchanged.')).toBeInTheDocument();
  expect(putRequest).toBeUndefined();

  await user.click(within(card!).getByRole('radio', { name: 'Replace' }));
  const replacement = within(card!).getByLabelText('New Slack bot token');
  expect(replacement).toHaveValue('');
  await user.type(replacement, 'xoxb-replacement-secret');
  await user.click(within(card!).getByRole('button', { name: 'Apply replace' }));

  expect(putRequest).toEqual({
    body: { value: 'xoxb-replacement-secret' },
    csrf: 'csrf-token',
  });
  expect(await screen.findByRole('status', { name: 'Restart required' })).toBeInTheDocument();
  expect(screen.queryByDisplayValue('xoxb-replacement-secret')).not.toBeInTheDocument();
});

test('explains environment precedence while allowing stored Claude credential deletion', async () => {
  const user = userEvent.setup();
  let deleted = false;
  const environmentConfiguration = configurationFixture({
    secrets: {
      ...configurationFixture().secrets,
      'claudeAgentSdk.oauthToken': {
        configured: true,
        source: 'environment',
        updatedAt: null,
        displayHint: null,
      },
    },
  });
  server.use(
    http.get('/api/configuration', () => HttpResponse.json(environmentConfiguration)),
    http.delete('/api/secrets/:name', ({ params }) => {
      deleted = params.name === 'claudeAgentSdk.oauthToken';
      return HttpResponse.json({ ...environmentConfiguration, restartRequired: false });
    }),
  );
  renderApp('/connections');

  const heading = await screen.findByRole('heading', { name: 'Claude OAuth token' });
  const card = heading.closest('article');
  expect(card).not.toBeNull();
  expect(within(card!).getByRole('note')).toHaveTextContent('is the effective credential');
  await user.click(within(card!).getByRole('radio', { name: 'Delete' }));
  await user.click(within(card!).getByRole('button', { name: 'Apply delete' }));

  expect(deleted).toBe(true);
  expect(within(card!).getByText('Environment')).toBeInTheDocument();
});

test('shows explicit Slack and backend check results separately from saved state', async () => {
  const user = userEvent.setup();
  server.use(
    http.post('/api/connections/check', async ({ request }) => {
      const { target } = (await request.json()) as { target: string };
      if (target === 'slack.bot') {
        return HttpResponse.json(connectionsFixture({
          'slack.bot': {
            target: 'slack.bot',
            status: 'missing_scope',
            checkedAt: '2026-08-03T01:00:00.000Z',
            summary: 'Slack bot authentication succeeded, but required scopes are missing.',
            details: { missingScopes: ['files:write'] },
          },
        }));
      }
      return HttpResponse.json(connectionsFixture({
        agent: {
          target: 'agent',
          status: 'ok',
          checkedAt: '2026-08-03T01:01:00.000Z',
          summary: 'The Pi model, provider credential, and effort are compatible.',
          details: {
            backend: {
              name: 'pi',
              provider: 'anthropic',
              model: 'anthropic/claude-sonnet-4-5',
              effort: 'high',
              credentialSource: 'oauth',
            },
          },
        },
      }));
    }),
  );
  renderApp('/connections');

  const botCard = (await screen.findByRole('heading', { name: 'Slack bot token' })).closest('article');
  await user.click(within(botCard!).getByRole('button', { name: 'Run connection check' }));
  expect(await within(botCard!).findByText(/required scopes are missing/)).toBeInTheDocument();
  expect(within(botCard!).getByText(/files:write/)).toBeInTheDocument();
  expect(within(botCard!).getByText('Configured')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Run backend check' }));
  expect(await screen.findByText(/Pi model, provider credential, and effort are compatible/)).toBeInTheDocument();
});

test('recovers from a connections load error and announces pending loading', async () => {
  const user = userEvent.setup();
  let requests = 0;
  server.use(
    http.get('/api/connections', async () => {
      requests += 1;
      if (requests === 1) return HttpResponse.error();
      await delay(20);
      return HttpResponse.json(connectionsFixture());
    }),
  );
  renderApp('/connections');

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load connections');
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(screen.getByRole('status', { name: 'Loading connections' })).toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: 'Credentials' })).toBeInTheDocument();
  expect(screen.getAllByText('Not checked in this daemon session.')).toHaveLength(3);
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
