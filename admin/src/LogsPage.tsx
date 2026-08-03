import { useEffect, useMemo, useState } from 'react';
import type { LogHistory, LogLevel, LogRecord } from '../../src/skyd/logger';
import { ApiError, requestJson } from './api';

type LogsPageProps = {
  onSessionExpired(): void;
};

type LoadPhase = 'loading' | 'ready' | 'error';
type StreamPhase = 'connecting' | 'live' | 'reconnecting';

function mergeRecords(current: readonly LogRecord[], added: readonly LogRecord[]): LogRecord[] {
  const byCursor = new Map(current.map((record) => [record.cursor, record]));
  for (const record of added) byCursor.set(record.cursor, record);
  return [...byCursor.values()].slice(-1_000);
}

function historyPath(cursor?: string): string {
  const parameters = new URLSearchParams({ limit: '200' });
  if (cursor) parameters.set('cursor', cursor);
  return `/api/logs?${parameters}`;
}

export function LogsPage({ onSessionExpired }: LogsPageProps) {
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [loadPhase, setLoadPhase] = useState<LoadPhase>('loading');
  const [streamPhase, setStreamPhase] = useState<StreamPhase>('connecting');
  const [level, setLevel] = useState<LogLevel | 'all'>('all');
  const [scope, setScope] = useState('');
  const [notice, setNotice] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | undefined;
    let reconnectTimer: number | undefined;
    let cursor: string | undefined;

    const expireSession = (error: unknown): boolean => {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return true;
      }
      return false;
    };

    const openStream = () => {
      if (disposed) return;
      setStreamPhase('connecting');
      const parameters = new URLSearchParams();
      if (cursor) parameters.set('cursor', cursor);
      source = new EventSource(`/api/logs/stream${parameters.size ? `?${parameters}` : ''}`);
      source.addEventListener('open', () => {
        if (!disposed) setStreamPhase('live');
      });
      source.addEventListener('log', (event) => {
        if (disposed) return;
        try {
          const message = event as MessageEvent<string>;
          const record = JSON.parse(message.data) as LogRecord;
          cursor = message.lastEventId || record.cursor;
          setRecords((current) => mergeRecords(current, [record]));
        } catch {
          setNotice('Sky received a malformed log event and skipped it.');
        }
      });
      source.addEventListener('error', () => {
        source?.close();
        source = undefined;
        if (disposed) return;
        setStreamPhase('reconnecting');
        void recover();
      });
    };

    const recover = async () => {
      try {
        const history = await requestJson<LogHistory>(historyPath(cursor));
        if (disposed) return;
        cursor = history.nextCursor ?? cursor;
        setRecords((current) => mergeRecords(current, history.records));
        openStream();
      } catch (error) {
        if (disposed || expireSession(error)) return;
        if (error instanceof ApiError && error.status === 410) {
          try {
            const tail = await requestJson<LogHistory>(historyPath());
            if (disposed) return;
            cursor = tail.nextCursor ?? undefined;
            setRecords(tail.records);
            setNotice('Older log history rotated away. Live tail resumed from the newest available records.');
            openStream();
            return;
          } catch (tailError) {
            if (disposed || expireSession(tailError)) return;
          }
        }
        reconnectTimer = window.setTimeout(openStream, 1_000);
      }
    };

    const start = async () => {
      setLoadPhase('loading');
      setNotice(undefined);
      try {
        const history = await requestJson<LogHistory>(historyPath());
        if (disposed) return;
        cursor = history.nextCursor ?? undefined;
        setRecords(history.records);
        setLoadPhase('ready');
        openStream();
      } catch (error) {
        if (disposed || expireSession(error)) return;
        setLoadPhase('error');
      }
    };

    void start();
    return () => {
      disposed = true;
      source?.close();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    };
  }, [onSessionExpired, reloadKey]);

  const visibleRecords = useMemo(() => {
    const scopeFilter = scope.trim().toLowerCase();
    return records.filter(
      (record) =>
        (level === 'all' || record.level === level) &&
        (!scopeFilter || record.scope.toLowerCase().includes(scopeFilter)),
    );
  }, [level, records, scope]);

  return (
    <div className="page logs-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Structured daemon output</p>
          <h1>Logs</h1>
          <p>Read recent safe log records and follow the daemon without exposing message payloads.</p>
        </div>
        {loadPhase === 'ready' && (
          <span className={`stream-state stream-${streamPhase}`} role="status">
            <i aria-hidden="true" />{streamPhase === 'live' ? 'Live' : streamPhase}
          </span>
        )}
      </header>

      {loadPhase === 'loading' ? (
        <section className="loading-panel" role="status" aria-label="Loading logs">
          <span className="loading-orbit" aria-hidden="true" />
          <div><strong>Reading log history</strong><p>Opening the authenticated live tail.</p></div>
        </section>
      ) : loadPhase === 'error' ? (
        <section className="error-panel" role="alert">
          <p className="eyebrow">Logs unavailable</p><h2>Could not load log history</h2>
          <p>The daemon may still be starting or reconnecting.</p>
          <button className="secondary-button" type="button" onClick={() => setReloadKey((key) => key + 1)}>Retry</button>
        </section>
      ) : (
        <>
          {notice && <p className="management-message log-notice" role="status">{notice}</p>}
          <section className="log-toolbar" aria-label="Log filters">
            <label>Level
              <select value={level} onChange={(event) => setLevel(event.target.value as LogLevel | 'all')}>
                <option value="all">All levels</option>
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </label>
            <label>Scope
              <input value={scope} onChange={(event) => setScope(event.target.value)} placeholder="Filter scope" />
            </label>
            <span>{visibleRecords.length} of {records.length} records</span>
          </section>
          {visibleRecords.length === 0 ? (
            <section className="management-empty"><span aria-hidden="true">○</span><h2>No matching logs</h2><p>Change the client-side filters or wait for a new record.</p></section>
          ) : (
            <ol className="log-list" aria-label="Daemon log records">
              {visibleRecords.map((record) => (
                <li key={record.cursor}>
                  <div className="log-meta">
                    <time dateTime={record.timestamp}>{new Date(record.timestamp).toLocaleString()}</time>
                    <span className={`log-level log-${record.level}`}>{record.level}</span>
                    <code>{record.scope}</code>
                  </div>
                  <p>{record.message}</p>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
