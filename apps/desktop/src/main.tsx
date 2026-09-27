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
