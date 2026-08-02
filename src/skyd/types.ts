export type RuntimeState =
  | 'starting'
  | 'ready'
  | 'needs_configuration'
  | 'degraded'
  | 'draining';

export type SlackConnectionState =
  | 'not_configured'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'stopped';

export type DaemonStatus = {
  instanceId: string;
  process: {
    pid: number;
    state: 'running' | 'stopping';
    startedAt: string;
    uptimeMs: number;
  };
  runtime: {
    state: RuntimeState;
  };
  productVersion: string;
  slack: {
    state: SlackConnectionState;
    attempts: number;
    nextRetryAt: string | null;
  };
  agent: {
    backend: 'pi' | 'claude-agent-sdk' | null;
    model: string | null;
  };
  activeWorkCount: number;
  recentErrors: Array<{
    code: string;
    at: string;
  }>;
};
