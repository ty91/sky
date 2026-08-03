import type { AdminOverview } from '../../src/skyd/types';

export function overviewFixture(
  overrides: Partial<AdminOverview> = {},
): AdminOverview {
  return {
    schemaVersion: 1,
    host: {
      hostname: 'taeyoung-mac',
      platform: 'darwin',
      architecture: 'arm64',
    },
    daemon: {
      instanceId: 'instance-1',
      supervision: { mode: 'launchd' },
      process: {
        pid: 4815,
        state: 'running',
        startedAt: '2026-08-03T00:00:00.000Z',
        uptimeMs: 3_723_000,
      },
      runtime: { state: 'ready' },
      productVersion: '0.1.0',
      slack: { state: 'connected', attempts: 0, nextRetryAt: null },
      agent: { backend: 'pi', model: 'anthropic/claude-sonnet-4-5' },
      admin: { state: 'listening', host: '0.0.0.0', port: 4815, error: null },
      activeWorkCount: 1,
      recentErrors: [],
    },
    diagnostics: {
      schemaVersion: 1,
      mode: 'daemon',
      overall: 'pass',
      checks: [
        {
          id: 'workspace.path',
          status: 'pass',
          summary: 'Workspace is readable and writable.',
          detail: null,
          remediation: null,
        },
      ],
    },
    scheduler: {
      total: 3,
      pending: 2,
      running: 1,
      failed: 0,
      nextRunAt: '2026-08-03T02:00:00.000Z',
    },
    ...overrides,
  };
}
