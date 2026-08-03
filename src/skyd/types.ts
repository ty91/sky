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

export type AdminGatewayStatus = {
  state: 'starting' | 'listening' | 'failed' | 'stopped';
  host: string;
  port: number;
  error: { code: 'admin_bind_failed' } | null;
};

export type DaemonStatus = {
  instanceId: string;
  supervision: {
    mode: 'launchd' | 'foreground';
  };
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
  admin: AdminGatewayStatus;
  activeWorkCount: number;
  recentErrors: Array<{
    code: string;
    at: string;
  }>;
};
