import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import type { ControlConfiguration } from '../../src/skyd/control';
import type { AdminOverview } from '../../src/skyd/types';
import type {
  WorkspacePrompt,
  WorkspacePromptSnapshot,
} from '../../src/workspace-prompts';

type Session = {
  csrfToken: string;
  expiresAt: string;
};

type AuthenticationState =
  | { phase: 'checking' }
  | { phase: 'anonymous'; message?: string }
  | { phase: 'unreachable' }
  | { phase: 'authenticated'; session: Session };

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`Admin request failed with status ${status}.`);
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
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

function takeFragmentToken(): string | undefined {
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  const token = parameters.get('token')?.trim();
  if (window.location.hash) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
  return token || undefined;
}

function Login({
  message,
  onAuthenticated,
}: {
  message?: string;
  onAuthenticated(session: Session): void;
}) {
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(message);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const session = await requestJson<Session>('/api/auth/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      onAuthenticated(session);
    } catch (requestError) {
      setError(
        requestError instanceof ApiError && requestError.status === 401
          ? 'That token has expired or was already used.'
          : 'Sky could not exchange the token. Check the daemon connection and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <div className="login-glow" aria-hidden="true" />
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand-mark" aria-hidden="true">
          S
        </div>
        <p className="eyebrow">Private control plane</p>
        <h1 id="login-title">Sign in to Sky</h1>
        <p className="login-intro">
          Run <code>sky admin --no-open</code> on the host, then paste the one-time token below.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="login-token">One-time token</label>
          <input
            id="login-token"
            name="token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            spellCheck="false"
            required
            autoFocus
          />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button" type="submit" disabled={submitting || !token.trim()}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="login-footnote">Tokens expire after five minutes and can only be used once.</p>
      </section>
    </main>
  );
}

function ConnectionUnavailable({ onRetry }: { onRetry(): void }) {
  return (
    <main className="login-page">
      <div className="login-glow" aria-hidden="true" />
      <section className="login-card connection-card" role="alert">
        <div className="brand-mark" aria-hidden="true">S</div>
        <p className="eyebrow">Connection failed</p>
        <h1>Could not reach Sky</h1>
        <p className="login-intro">
          The admin assets loaded, but the daemon did not answer the session check. This is not a sign-out.
        </p>
        <button className="primary-button" type="button" onClick={onRetry}>Retry</button>
      </section>
    </main>
  );
}

const navigation = [
  ['/', 'Dashboard'],
  ['/connections', 'Connections'],
  ['/agent', 'Agent'],
  ['/sessions', 'Sessions'],
  ['/scheduler', 'Scheduler'],
  ['/logs', 'Logs'],
  ['/system', 'System'],
] as const;

function Shell({
  session,
  onSessionExpired,
}: {
  session: Session;
  onSessionExpired(): void;
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark brand-mark-small" aria-hidden="true">S</span>
          <span>
            <strong>Sky</strong>
            <small>Admin</small>
          </span>
        </div>
        <nav aria-label="Admin navigation">
          {navigation.map(([path, label]) => (
            <NavLink
              key={path}
              to={path}
              end={path === '/'}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              <span className="nav-indicator" aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="connection-dot" aria-hidden="true" />
          Local admin session
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard onSessionExpired={onSessionExpired} />} />
          <Route
            path="/agent"
            element={
              <Agent
                session={session}
                onSessionExpired={onSessionExpired}
              />
            }
          />
          {navigation.filter(([path]) => path !== '/' && path !== '/agent').map(([path, label]) => (
            <Route key={path} path={path} element={<Placeholder title={label} />} />
          ))}
          <Route path="*" element={<Dashboard onSessionExpired={onSessionExpired} />} />
        </Routes>
      </main>
    </div>
  );
}

type AgentForm = {
  agentBackend: ControlConfiguration['settings']['agentBackend'];
  model: string;
  effort: '' | NonNullable<ControlConfiguration['settings']['effort']>;
  workspace: string;
};

type AgentAction =
  | { phase: 'idle'; message?: string }
  | { phase: 'saving' }
  | { phase: 'restarting' }
  | { phase: 'conflict'; message: string }
  | { phase: 'error'; message: string };

function formFromConfiguration(configuration: ControlConfiguration): AgentForm {
  return {
    agentBackend: configuration.settings.agentBackend,
    model: configuration.settings.model ?? '',
    effort: configuration.settings.effort ?? '',
    workspace: configuration.settings.workspace,
  };
}

function conflictConfiguration(error: ApiError): ControlConfiguration | undefined {
  const current = error.details.current;
  if (
    !current ||
    typeof current !== 'object' ||
    !('revision' in current) ||
    !('settings' in current)
  ) {
    return undefined;
  }
  return current as ControlConfiguration;
}

function Agent({
  session,
  onSessionExpired,
}: {
  session: Session;
  onSessionExpired(): void;
}) {
  const [configuration, setConfiguration] = useState<ControlConfiguration>();
  const [promptSnapshot, setPromptSnapshot] = useState<WorkspacePromptSnapshot>();
  const [form, setForm] = useState<AgentForm>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [action, setAction] = useState<AgentAction>({ phase: 'idle' });

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [nextConfiguration, nextPrompts] = await Promise.all([
        requestJson<ControlConfiguration>('/api/configuration'),
        requestJson<WorkspacePromptSnapshot>('/api/prompts'),
      ]);
      setConfiguration(nextConfiguration);
      setForm(formFromConfiguration(nextConfiguration));
      setPromptSnapshot(nextPrompts);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [onSessionExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!configuration || !form) return;
    const model = form.model.trim();
    const workspace = form.workspace.trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(model)) {
      setAction({ phase: 'error', message: 'Model must use provider/model format.' });
      return;
    }
    if (form.agentBackend === 'claude-agent-sdk' && !model.startsWith('anthropic/')) {
      setAction({
        phase: 'error',
        message: 'Claude Agent SDK models must use the anthropic/ provider.',
      });
      return;
    }

    setAction({ phase: 'saving' });
    try {
      const updated = await requestJson<ControlConfiguration>('/api/configuration', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-sky-csrf-token': session.csrfToken,
        },
        body: JSON.stringify({
          expectedRevision: configuration.revision,
          patch: {
            agentBackend: form.agentBackend,
            model,
            effort: form.effort || null,
            workspace,
          },
        }),
      });
      setConfiguration(updated);
      setForm(formFromConfiguration(updated));
      setAction({
        phase: 'idle',
        message: updated.restartRequired
          ? 'Configuration saved. Restart Sky to apply it to the active runtime.'
          : 'Configuration saved.',
      });
      try {
        const prompts = await requestJson<WorkspacePromptSnapshot>('/api/prompts');
        setPromptSnapshot(prompts);
      } catch (promptError) {
        if (promptError instanceof ApiError && promptError.status === 401) {
          onSessionExpired();
          return;
        }
        setAction({
          phase: 'idle',
          message: 'Configuration saved, but the prompt snapshot could not be refreshed.',
        });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        const current = conflictConfiguration(error);
        if (current) {
          setConfiguration(current);
          setForm(formFromConfiguration(current));
          setAction({
            phase: 'conflict',
            message: 'Configuration changed elsewhere. The latest values are loaded; review them and save again.',
          });
          return;
        }
      }
      setAction({
        phase: 'error',
        message: 'Configuration was not saved. Review the values and try again.',
      });
    }
  };

  const restart = async () => {
    setAction({ phase: 'restarting' });
    try {
      await requestJson<{ accepted: true }>('/api/restart', {
        method: 'POST',
        headers: { 'x-sky-csrf-token': session.csrfToken },
      });
      setAction({
        phase: 'idle',
        message: 'Graceful restart requested. Sign in again after the daemon returns.',
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      setAction({
        phase: 'error',
        message: 'Sky could not start a graceful restart. The saved configuration is unchanged.',
      });
    }
  };

  if (loading) {
    return (
      <div className="page agent-page">
        <AgentHeader />
        <section className="loading-panel" role="status" aria-label="Loading agent settings">
          <span className="loading-orbit" aria-hidden="true" />
          <div><strong>Reading agent configuration</strong><p>Inspecting settings and prompt files.</p></div>
        </section>
      </div>
    );
  }

  if (loadError || !configuration || !form || !promptSnapshot) {
    return (
      <div className="page agent-page">
        <AgentHeader />
        <section className="error-panel" role="alert">
          <p className="eyebrow">Connection failed</p>
          <h2>Could not load agent settings</h2>
          <p>The existing configuration was not changed.</p>
          <button className="secondary-button" type="button" onClick={() => void load()}>Retry</button>
        </section>
      </div>
    );
  }

  return (
    <div className="page agent-page">
      <AgentHeader />
      {configuration.restartRequired && (
        <section className="restart-banner" role="status" aria-label="Restart required">
          <div>
            <p className="eyebrow">Pending runtime change</p>
            <strong>Restart required</strong>
            <span>Revision {configuration.revision} is saved; the active runtime uses revision {configuration.activeRevision ?? 'none'}.</span>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={action.phase === 'restarting'}
            onClick={() => void restart()}
          >
            {action.phase === 'restarting' ? 'Restarting…' : 'Graceful restart'}
          </button>
        </section>
      )}

      <section className="panel settings-panel" aria-labelledby="agent-settings-heading">
        <PanelHeader eyebrow={`Configuration revision ${configuration.revision}`} title="Agent settings" id="agent-settings-heading" />
        <form className="settings-form" onSubmit={save}>
          <label>
            <span>Backend</span>
            <select
              aria-label="Backend"
              value={form.agentBackend}
              onChange={(event) => setForm({ ...form, agentBackend: event.target.value as AgentForm['agentBackend'] })}
            >
              <option value="pi">Pi</option>
              <option value="claude-agent-sdk">Claude Agent SDK</option>
            </select>
          </label>
          <label>
            <span>Model</span>
            <input aria-label="Model" value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} required spellCheck="false" />
            <small>{form.agentBackend === 'claude-agent-sdk' ? 'anthropic/model' : 'provider/model'}</small>
          </label>
          <label>
            <span>Effort</span>
            <select aria-label="Effort" value={form.effort} onChange={(event) => setForm({ ...form, effort: event.target.value as AgentForm['effort'] })}>
              <option value="">Backend default</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra high</option>
            </select>
          </label>
          <label className="workspace-field">
            <span>Workspace</span>
            <input aria-label="Workspace" value={form.workspace} onChange={(event) => setForm({ ...form, workspace: event.target.value })} required spellCheck="false" />
            <small>Absolute path on the daemon host</small>
          </label>
          <div className="form-actions">
            <button className="primary-button" type="submit" disabled={action.phase === 'saving'}>
              {action.phase === 'saving' ? 'Saving…' : 'Save configuration'}
            </button>
            {(action.phase === 'error' || action.phase === 'conflict') && <p className="form-error" role="alert">{action.message}</p>}
            {action.phase === 'idle' && action.message && <p className="form-success" role="status">{action.message}</p>}
          </div>
        </form>
      </section>

      <section className="prompt-section" aria-labelledby="prompt-files-heading">
        <header className="prompt-section-header">
          <div><p className="eyebrow">Read-only workspace view</p><h2 id="prompt-files-heading">Prompt files</h2></div>
          <span>Content limit {formatBytes(promptSnapshot.maxContentBytes)}</span>
        </header>
        <div className="prompt-grid">
          {promptSnapshot.prompts.map((prompt) => <PromptCard key={prompt.role} prompt={prompt} />)}
        </div>
      </section>
    </div>
  );
}

function AgentHeader() {
  return (
    <header className="page-header">
      <div><p className="eyebrow">Runtime configuration</p><h1>Agent</h1><p>Manage the next runtime configuration and inspect its prompt inputs.</p></div>
    </header>
  );
}

function PromptCard({ prompt }: { prompt: WorkspacePrompt }) {
  const descriptions: Record<WorkspacePrompt['status'], string> = {
    available: prompt.content?.length ? 'Content loaded' : 'File is empty',
    missing: 'No workspace entry exists for this role.',
    unreadable: 'The entry or its UTF-8 content could not be read.',
    broken_symlink: 'The symlink target is missing or cyclic.',
    non_file: 'The entry does not resolve to a regular file.',
    too_large: 'Content is hidden because the file exceeds the read limit.',
  };
  return (
    <article className={`prompt-card prompt-${prompt.status}`}>
      <header>
        <div><p className="eyebrow">{prompt.role}</p><h3>{prompt.filename}</h3></div>
        <span className="prompt-badge">{prompt.status.replace('_', ' ')}</span>
      </header>
      <dl className="prompt-meta">
        <div><dt>Entry</dt><dd>{prompt.entry.type}</dd></div>
        <div><dt>Target</dt><dd>{prompt.target.state}</dd></div>
        <div><dt>Size</dt><dd>{prompt.target.sizeBytes === null ? '—' : formatBytes(prompt.target.sizeBytes)}</dd></div>
        <div><dt>Modified</dt><dd>{prompt.target.modifiedAt ? formatDate(prompt.target.modifiedAt) : '—'}</dd></div>
      </dl>
      {prompt.status === 'available' ? (
        <pre className="prompt-content">{prompt.content || 'Empty file'}</pre>
      ) : (
        <p className="prompt-diagnostic">{descriptions[prompt.status]}</p>
      )}
    </article>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes % 1024 === 0 ? 0 : 1)} KiB`;
}

function Placeholder({ title }: { title: string }) {
  return (
    <div className="page placeholder-page">
      <p className="eyebrow">Sky admin</p>
      <h1>{title}</h1>
      <div className="placeholder-panel">
        <span>Coming in the next admin slice</span>
        <p>This area is wired into the application shell and ready for its management workflow.</p>
      </div>
    </div>
  );
}

type DashboardPhase = 'loading' | 'ready' | 'error' | 'reconnecting';

function Dashboard({ onSessionExpired }: { onSessionExpired(): void }) {
  const [overview, setOverview] = useState<AdminOverview>();
  const [phase, setPhase] = useState<DashboardPhase>('loading');
  const overviewRef = useRef<AdminOverview | undefined>(undefined);

  useEffect(() => {
    overviewRef.current = overview;
  }, [overview]);

  const loadOverview = useCallback(async () => {
    if (!overviewRef.current) setPhase('loading');
    try {
      const next = await requestJson<AdminOverview>('/api/overview');
      overviewRef.current = next;
      setOverview(next);
      setPhase('ready');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      setPhase(overviewRef.current ? 'reconnecting' : 'error');
    }
  }, [onSessionExpired]);

  useEffect(() => {
    void loadOverview();
    const interval = window.setInterval(() => void loadOverview(), 15_000);
    return () => window.clearInterval(interval);
  }, [loadOverview]);

  if (phase === 'loading') {
    return (
      <div className="page dashboard-page">
        <PageHeader />
        <section className="loading-panel" role="status" aria-label="Loading dashboard">
          <span className="loading-orbit" aria-hidden="true" />
          <div>
            <strong>Reading daemon state</strong>
            <p>Collecting runtime, workspace, and scheduler diagnostics.</p>
          </div>
        </section>
      </div>
    );
  }

  if (phase === 'error' || !overview) {
    return (
      <div className="page dashboard-page">
        <PageHeader />
        <section className="error-panel" role="alert">
          <p className="eyebrow">Connection failed</p>
          <h2>Could not reach Sky</h2>
          <p>The admin shell is available, but the daemon overview request did not complete.</p>
          <button className="secondary-button" type="button" onClick={() => void loadOverview()}>
            Retry
          </button>
        </section>
      </div>
    );
  }

  const degraded =
    overview.daemon.runtime.state !== 'ready' || overview.diagnostics.overall !== 'pass';
  const workspaceChecks = overview.diagnostics.checks.filter(({ id }) => id.startsWith('workspace.'));

  return (
    <div className="page dashboard-page">
      <PageHeader onRefresh={() => void loadOverview()} />
      {phase === 'reconnecting' && (
        <section className="reconnect-banner" role="status" aria-label="Daemon connection">
          <span className="pulse-dot" aria-hidden="true" />
          <div>
            <strong>Reconnecting to the daemon</strong>
            <span>The last known overview stays visible while Sky comes back online.</span>
          </div>
          <button className="text-button" type="button" onClick={() => void loadOverview()}>
            Retry connection
          </button>
        </section>
      )}
      <section
        className={degraded ? 'health-banner degraded' : 'health-banner healthy'}
        role="status"
        aria-label="System status"
      >
        <div className="health-icon" aria-hidden="true">{degraded ? '!' : '✓'}</div>
        <div>
          <p className="eyebrow">System status</p>
          <h2>{degraded ? 'Degraded' : 'All systems operational'}</h2>
        </div>
        <span className="health-meta">{labelState(overview.daemon.runtime.state)}</span>
      </section>

      <div className="metric-grid">
        <Metric label="Daemon" value={overview.daemon.productVersion} detail={formatDuration(overview.daemon.process.uptimeMs)} />
        <Metric label="Runtime" value={labelState(overview.daemon.runtime.state)} detail={`${overview.daemon.activeWorkCount} active work`} tone={overview.daemon.runtime.state === 'ready' ? 'good' : 'warn'} />
        <Metric label="Slack" value={labelState(overview.daemon.slack.state)} detail={overview.daemon.slack.attempts ? `${overview.daemon.slack.attempts} reconnect attempts` : 'Socket mode'} tone={overview.daemon.slack.state === 'connected' ? 'good' : 'warn'} />
        <Metric label="Host" value={overview.host.hostname} detail={`${overview.host.platform} · ${overview.host.architecture}`} />
      </div>

      <div className="dashboard-columns">
        <section className="panel agent-panel" aria-labelledby="agent-heading">
          <PanelHeader eyebrow="Active configuration" title="Agent" id="agent-heading" />
          <dl className="definition-list">
            <div><dt>Backend</dt><dd>{overview.daemon.agent.backend ?? 'Not configured'}</dd></div>
            <div><dt>Model</dt><dd>{overview.daemon.agent.model ?? 'Not configured'}</dd></div>
            <div><dt>Supervision</dt><dd>{overview.daemon.supervision.mode}</dd></div>
            <div><dt>Instance</dt><dd className="mono">{overview.daemon.instanceId}</dd></div>
          </dl>
        </section>

        <section className="panel scheduler-panel" aria-labelledby="scheduler-heading">
          <PanelHeader eyebrow="Automation" title="Scheduler" id="scheduler-heading" />
          <div className="scheduler-stats">
            <Stat value={overview.scheduler.pending} label="Pending" />
            <Stat value={overview.scheduler.running} label="Running" />
            <Stat value={overview.scheduler.failed} label="Failed" warn={overview.scheduler.failed > 0} />
          </div>
          <p className="next-run">
            <span>Next run</span>
            <strong>{overview.scheduler.nextRunAt ? formatDate(overview.scheduler.nextRunAt) : 'Nothing scheduled'}</strong>
          </p>
        </section>

        <section className="panel workspace-panel" aria-labelledby="workspace-heading">
          <PanelHeader eyebrow="Diagnostics" title="Workspace" id="workspace-heading" />
          <ul className="diagnostic-list">
            {workspaceChecks.map((check) => (
              <li key={check.id}>
                <span className={`check-marker ${check.status}`} aria-hidden="true" />
                <div>
                  <strong>{check.summary}</strong>
                  {check.detail && <p>{check.detail}</p>}
                  {check.remediation && <p className="remediation">{check.remediation}</p>}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel errors-panel" aria-labelledby="errors-heading">
          <PanelHeader eyebrow="Runtime history" title="Recent errors" id="errors-heading" />
          {overview.daemon.recentErrors.length === 0 ? (
            <div className="empty-state"><span aria-hidden="true">✓</span>No recent errors</div>
          ) : (
            <ul className="error-list">
              {overview.daemon.recentErrors.toReversed().map((error) => (
                <li key={`${error.code}-${error.at}`}>
                  <code>{error.code}</code>
                  <time dateTime={error.at}>{formatDate(error.at)}</time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function PageHeader({ onRefresh }: { onRefresh?: () => void }) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">Overview</p>
        <h1>Dashboard</h1>
        <p>One clear view of the machine running Sky.</p>
      </div>
      {onRefresh && (
        <button className="icon-button" type="button" onClick={onRefresh} aria-label="Refresh dashboard">
          <span aria-hidden="true">↻</span>
        </button>
      )}
    </header>
  );
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: 'good' | 'warn' }) {
  return (
    <article className="metric-card">
      <p>{label}</p>
      <strong>{value}</strong>
      <span className={tone ? `metric-detail ${tone}` : 'metric-detail'}>{tone && <i aria-hidden="true" />}{detail}</span>
    </article>
  );
}

function PanelHeader({ eyebrow, title, id }: { eyebrow: string; title: string; id: string }) {
  return <header className="panel-header"><div><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div></header>;
}

function Stat({ value, label, warn }: { value: number; label: string; warn?: boolean }) {
  return <div className={warn ? 'stat warn' : 'stat'}><strong>{value}</strong><span>{label}</span></div>;
}

function labelState(value: string): string {
  return value.split('_').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  if (days > 0) return `Up ${days}d ${hours}h`;
  if (hours > 0) return `Up ${hours}h ${remainingMinutes}m`;
  return `Up ${remainingMinutes}m`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function AdminApp() {
  const [authentication, setAuthentication] = useState<AuthenticationState>({ phase: 'checking' });
  const [fragmentToken] = useState(takeFragmentToken);

  const authenticate = useCallback(async () => {
    setAuthentication({ phase: 'checking' });
    try {
      const session = fragmentToken
        ? await requestJson<Session>('/api/auth/exchange', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: fragmentToken }),
          })
        : await requestJson<Session>('/api/auth/session');
      setAuthentication({ phase: 'authenticated', session });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuthentication({
          phase: 'anonymous',
          message: fragmentToken ? 'That token has expired or was already used.' : undefined,
        });
      } else {
        setAuthentication({ phase: 'unreachable' });
      }
    }
  }, [fragmentToken]);

  useEffect(() => {
    void authenticate();
  }, [authenticate]);

  if (authentication.phase === 'checking') {
    return <main className="boot-screen" role="status" aria-label="Opening Sky Admin"><span className="loading-orbit" aria-hidden="true" />Opening Sky Admin</main>;
  }
  if (authentication.phase === 'anonymous') {
    return <Login message={authentication.message} onAuthenticated={(session) => setAuthentication({ phase: 'authenticated', session })} />;
  }
  if (authentication.phase === 'unreachable') {
    return <ConnectionUnavailable onRetry={() => void authenticate()} />;
  }
  return <Shell session={authentication.session} onSessionExpired={() => setAuthentication({ phase: 'anonymous', message: 'Your admin session expired. Sign in again.' })} />;
}

export function App() {
  return <BrowserRouter><AdminApp /></BrowserRouter>;
}
