import { useCallback, useEffect, useState } from 'react';
import type { SystemSnapshot } from '../../src/skyd/types';
import { ApiError, requestJson, type Session } from './api';

type SystemPageProps = {
  session: Session;
  onSessionExpired(): void;
  onRestartAccepted(): void;
};

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}

export function SystemPage({
  session,
  onSessionExpired,
  onRestartAccepted,
}: SystemPageProps) {
  const [snapshot, setSnapshot] = useState<SystemSnapshot>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setSnapshot(await requestJson<SystemSnapshot>('/api/system'));
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

  const restart = async () => {
    setRestarting(true);
    setRestartError(undefined);
    try {
      await requestJson<{ accepted: true }>('/api/restart', {
        method: 'POST',
        headers: { 'x-sky-csrf-token': session.csrfToken },
      });
      onRestartAccepted();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      if (error instanceof ApiError && typeof error.details.message === 'string') {
        setRestartError(error.details.message);
      } else {
        setRestartError('Sky could not start a graceful restart. The daemon is still running.');
      }
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="page system-page">
      <header className="page-header">
        <div><p className="eyebrow">Daemon and service</p><h1>System</h1><p>Inspect the installed service and control daemon lifecycle.</p></div>
      </header>
      {loading ? (
        <section className="loading-panel" role="status" aria-label="Loading system status">
          <span className="loading-orbit" aria-hidden="true" />
          <div><strong>Reading system state</strong><p>Checking the daemon and LaunchAgent.</p></div>
        </section>
      ) : loadError || !snapshot ? (
        <section className="error-panel" role="alert">
          <p className="eyebrow">System unavailable</p><h2>Could not load system status</h2>
          <p>The daemon may still be starting or reconnecting.</p>
          <button className="secondary-button" type="button" onClick={() => void load()}>Retry</button>
        </section>
      ) : (
        <>
          <div className="system-grid">
            <section className="panel" aria-labelledby="daemon-system-heading">
              <header className="panel-header"><div><p className="eyebrow">Active process</p><h2 id="daemon-system-heading">Daemon</h2></div></header>
              <dl className="definition-list">
                <div><dt>Version</dt><dd>{snapshot.daemon.productVersion}</dd></div>
                <div><dt>Supervision</dt><dd>{snapshot.daemon.supervision.mode}</dd></div>
                <div><dt>Runtime</dt><dd>{snapshot.daemon.runtime.state.replaceAll('_', ' ')}</dd></div>
                <div><dt>Admin listener</dt><dd className="mono">{snapshot.daemon.admin.host}:{snapshot.daemon.admin.port}</dd></div>
                <div><dt>Admin state</dt><dd>{snapshot.daemon.admin.state}</dd></div>
              </dl>
            </section>
            <section className="panel" aria-labelledby="launch-agent-heading">
              <header className="panel-header"><div><p className="eyebrow">macOS service</p><h2 id="launch-agent-heading">LaunchAgent</h2></div></header>
              <dl className="definition-list">
                <div><dt>Supported</dt><dd>{yesNo(snapshot.launchAgent.supported)}</dd></div>
                <div><dt>Installed</dt><dd>{yesNo(snapshot.launchAgent.installed)}</dd></div>
                <div><dt>Loaded</dt><dd>{yesNo(snapshot.launchAgent.loaded)}</dd></div>
                <div><dt>Autostart</dt><dd>{yesNo(snapshot.launchAgent.autostart)}</dd></div>
                <div><dt>State</dt><dd>{snapshot.launchAgent.state ?? 'Not loaded'}</dd></div>
              </dl>
            </section>
          </div>

          <section className="panel system-actions" aria-labelledby="lifecycle-heading">
            <header className="panel-header"><div><p className="eyebrow">Lifecycle</p><h2 id="lifecycle-heading">Daemon control</h2></div></header>
            <p>Graceful restart drains active work. The replacement daemon invalidates this session, so a new <code>sky admin</code> token is required.</p>
            {restartError && <p className="form-error" role="alert">{restartError}</p>}
            <button className="primary-button" type="button" disabled={restarting} onClick={() => void restart()}>{restarting ? 'Requesting restart…' : 'Graceful restart'}</button>
          </section>

          <section className="panel capability-panel" aria-labelledby="capability-heading">
            <header className="panel-header"><div><p className="eyebrow">Package lifecycle</p><h2 id="capability-heading">Update and rollback</h2></div></header>
            <div className="capability-row"><span>Update</span><code>{snapshot.capabilities.update}</code></div>
            <div className="capability-row"><span>Rollback</span><code>{snapshot.capabilities.rollback}</code></div>
            <p>Package updates and rollback arrive in a later release stage. No action is available here.</p>
          </section>

          <section className="panel" aria-labelledby="recent-errors-heading">
            <header className="panel-header"><div><p className="eyebrow">Daemon history</p><h2 id="recent-errors-heading">Recent errors</h2></div></header>
            {snapshot.daemon.recentErrors.length === 0 ? (
              <div className="empty-state"><span aria-hidden="true">✓</span>No recent daemon errors</div>
            ) : (
              <ul className="error-list">
                {snapshot.daemon.recentErrors.toReversed().map((error) => (
                  <li key={`${error.code}-${error.at}`}><code>{error.code}</code><time dateTime={error.at}>{new Date(error.at).toLocaleString()}</time></li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
