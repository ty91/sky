import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import './style.css';

type BuildInfo = {
  appVersion: string;
  hostVersion: string;
  target: string;
  revision: string;
  mode: string;
};

type HostState = 'notRegistered' | 'approvalRequired' | 'running' | 'starting' | 'stopping' | 'stopped' | 'startupFailed' | 'connectionFailed' | 'conflict';
type HostSnapshot = {
  registration: 'notRegistered' | 'enabled' | 'requiresApproval' | 'notFound';
  hostState: HostState;
  daemon: { instanceId: string; process: { pid: number }; runtime: { state: string }; activeWorkCount: number } | null;
  detail: string | null;
  skyHome: string;
  canManage: boolean;
};
type HostAction = 'status' | 'register' | 'start' | 'stop' | 'restart' | 'unregister' | 'openSettings';
const hostStates: Record<HostState, string> = {
  notRegistered: '미등록', approvalRequired: '사용자 승인 대기', running: '실행 중',
  starting: '기동 중', stopping: '작업 정리 중', stopped: '중지됨',
  startupFailed: '호스트 기동 실패', connectionFailed: '제어 연결 실패', conflict: '기존 설치와 충돌',
};
const registrations = {
  notRegistered: '미등록', enabled: '활성화됨', requiresApproval: '승인 필요', notFound: '서비스를 찾을 수 없음',
};

function describeError(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'message' in cause && 'code' in cause) {
    return `${String(cause.message)} (${String(cause.code)})`;
  }
  return String(cause);
}

function HostControls() {
  const [host, setHost] = useState<HostSnapshot>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (busy) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const snapshot = await invoke<HostSnapshot>('host_service', { action: 'status' });
        if (active) setHost(snapshot);
      } catch (cause) {
        if (active) setError(describeError(cause));
      }
      if (active) timer = setTimeout(() => void refresh(), 3000);
    };
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [busy]);

  async function act(action: HostAction) {
    setBusy(true);
    setError(undefined);
    try {
      setHost(await invoke<HostSnapshot>('host_service', { action }));
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  const conflict = host?.hostState === 'conflict';
  return (
    <section aria-label="로컬 호스트" aria-busy={busy}>
      <h2>로컬 호스트</h2>
      {host && <dl>
        <dt>서비스 등록</dt><dd>{host.hostState === 'notRegistered' ? '미등록' : registrations[host.registration]}</dd>
        <dt>호스트 상태</dt><dd role="status">{hostStates[host.hostState]}</dd>
        {host.daemon && <>
          <dt>프로세스</dt><dd>{host.daemon.process.pid}</dd>
          <dt>실행 중 작업</dt><dd>{host.daemon.activeWorkCount}</dd>
        </>}
      </dl>}
      {host?.detail && <p role="alert">{host.detail}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <button disabled={busy} onClick={() => void act('status')}>새로고침</button>
        {host?.registration === 'requiresApproval' && <button disabled={busy} onClick={() => void act('openSettings')}>로그인 항목 설정</button>}
        <button disabled={busy || !host?.canManage || conflict || host.registration === 'requiresApproval' || ['running', 'starting', 'stopping'].includes(host.hostState)} onClick={() => void act(host?.registration === 'enabled' ? 'start' : 'register')}>
          {host?.registration === 'enabled' ? '호스트 시작' : '서비스 등록'}
        </button>
        <button disabled={busy || !host?.canManage || !host.daemon || conflict} onClick={() => void act('restart')}>재시작</button>
        <button disabled={busy || !host?.canManage || conflict || ['notRegistered', 'stopped', 'approvalRequired'].includes(host.hostState)} onClick={() => void act('stop')}>호스트 중지</button>
        <button disabled={busy || !host?.canManage || conflict || !['enabled', 'requiresApproval'].includes(host.registration)} onClick={() => void act('unregister')}>등록 해제</button>
      </div>
    </section>
  );
}

function App() {
  const [info, setInfo] = useState<BuildInfo>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    invoke<BuildInfo>('build_info').then(setInfo).catch((cause: unknown) => {
      setError(String(cause));
    });
  }, []);

  return (
    <main>
      <div className="mark" aria-hidden="true">S</div>
      <h1>Sky</h1>
      <HostControls />
      {error ? <p role="alert">{error}</p> : info ? (
        <dl>
          <dt>앱 버전</dt><dd>{info.appVersion}</dd>
          <dt>호스트 버전</dt><dd>{info.hostVersion}</dd>
          <dt>대상</dt><dd>{info.target}</dd>
          <dt>빌드</dt><dd>{info.revision}</dd>
          <dt>실행 모드</dt><dd>{info.mode === 'development' ? '개발' : '앱 번들'}</dd>
        </dl>
      ) : <p role="status">빌드 정보 불러오는 중</p>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
