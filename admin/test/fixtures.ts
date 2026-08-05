import type { AdminOverview, SystemSnapshot } from '../../src/skyd/types';
import type { LogHistory } from '../../src/skyd/logger';
import type { ControlConfiguration } from '../../src/skyd/control';
import type { WorkspacePrompt, WorkspacePromptSnapshot } from '../../src/workspace-prompts';
import type { ConnectionsSnapshot } from '../../src/connections';
import type {
  RuntimeScheduledJobsSnapshot,
  RuntimeSessionsSnapshot,
} from '../../src/runtime/admin';

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
      runtime: { kind: 'node', state: 'ready' },
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

export function configurationFixture(
  overrides: Partial<ControlConfiguration> = {},
): ControlConfiguration {
  return {
    schemaVersion: 1,
    revision: 2,
    activeRevision: 2,
    restartRequired: false,
    settings: {
      agentBackend: 'pi',
      model: 'anthropic/claude-sonnet-4-5',
      effort: 'high',
      workspace: '/Users/taeyoung/.sky/workspace',
    },
    secrets: {
      'slack.botToken': {
        configured: true,
        source: 'stored',
        updatedAt: '2026-08-03T00:00:00.000Z',
        displayHint: 'xoxb-…test',
      },
      'slack.appToken': {
        configured: true,
        source: 'stored',
        updatedAt: '2026-08-03T00:00:00.000Z',
        displayHint: 'xapp-…test',
      },
      'claudeAgentSdk.oauthToken': {
        configured: false,
        source: null,
        updatedAt: null,
        displayHint: null,
      },
    },
    complete: true,
    ...overrides,
  };
}

export function connectionsFixture(
  overrides: Partial<ConnectionsSnapshot['checks']> = {},
): ConnectionsSnapshot {
  return {
    schemaVersion: 1,
    checks: {
      'slack.bot': null,
      'slack.app': null,
      agent: null,
      ...overrides,
    },
  };
}

function promptFixture(
  role: WorkspacePrompt['role'],
  filename: WorkspacePrompt['filename'],
  overrides: Partial<WorkspacePrompt> = {},
): WorkspacePrompt {
  return {
    role,
    filename,
    status: 'available',
    entry: {
      exists: true,
      type: 'file',
      modifiedAt: '2026-08-03T00:00:00.000Z',
    },
    target: {
      state: 'file',
      sizeBytes: 16,
      modifiedAt: '2026-08-03T00:00:00.000Z',
    },
    content: `# ${role}`,
    ...overrides,
  };
}

export function promptSnapshotFixture(): WorkspacePromptSnapshot {
  return {
    maxContentBytes: 256 * 1024,
    prompts: [
      promptFixture('soul', 'SOUL.md'),
      promptFixture('agents', 'AGENTS.md', {
        status: 'missing',
        entry: { exists: false, type: 'missing', modifiedAt: null },
        target: { state: 'missing', sizeBytes: null, modifiedAt: null },
        content: null,
      }),
      promptFixture('user', 'USER.md', {
        status: 'broken_symlink',
        entry: {
          exists: true,
          type: 'symlink',
          modifiedAt: '2026-08-03T00:00:00.000Z',
        },
        target: { state: 'missing', sizeBytes: null, modifiedAt: null },
        content: null,
      }),
      promptFixture('memory', 'MEMORY.md', {
        status: 'too_large',
        target: {
          state: 'file',
          sizeBytes: 256 * 1024 + 1,
          modifiedAt: '2026-08-03T00:00:00.000Z',
        },
        content: null,
      }),
    ],
  };
}

export function sessionsFixture(): RuntimeSessionsSnapshot {
  return {
    sessions: [
      {
        threadKey: 'D123:1777901000.000000',
        backendSessionId: 'pi-session-1',
        backend: 'pi',
        model: 'anthropic/claude-sonnet-4-5',
        agent: 'main',
        createdAt: '2026-08-03T00:00:00.000Z',
        updatedAt: '2026-08-03T01:00:00.000Z',
      },
    ],
  };
}

export function scheduledJobsFixture(): RuntimeScheduledJobsSnapshot {
  return {
    jobs: [
      {
        id: 'job-pending',
        title: 'Pack passport',
        kind: 'once',
        nextRunAt: '2026-08-04T02:00:00.000Z',
        timezone: 'Asia/Seoul',
        target: 'D123',
        status: 'pending',
        lastRunAt: null,
        runCount: 0,
        errorSummary: null,
      },
      {
        id: 'job-running',
        title: 'Daily review',
        kind: 'cron',
        nextRunAt: '2026-08-04T03:00:00.000Z',
        timezone: 'Asia/Seoul',
        target: 'C456',
        status: 'running',
        lastRunAt: '2026-08-03T03:00:00.000Z',
        runCount: 3,
        errorSummary: 'The most recent run failed.',
      },
    ],
  };
}

export function logHistoryFixture(): LogHistory {
  return {
    records: [
      {
        cursor: 'instance-1:1',
        timestamp: '2026-08-03T00:00:00.000Z',
        level: 'info',
        scope: 'daemon',
        message: 'Control interface started.',
      },
      {
        cursor: 'instance-1:2',
        timestamp: '2026-08-03T00:00:01.000Z',
        level: 'warn',
        scope: 'slack',
        message: 'Slack connection will retry.',
      },
    ],
    nextCursor: 'instance-1:2',
  };
}

export function systemFixture(overrides: Partial<SystemSnapshot> = {}): SystemSnapshot {
  return {
    schemaVersion: 1,
    daemon: overviewFixture().daemon,
    launchAgent: {
      supported: true,
      label: 'com.ty91.skyd',
      plistFile: '/Users/taeyoung/Library/LaunchAgents/com.ty91.skyd.plist',
      installed: true,
      loaded: true,
      autostart: true,
      state: 'running',
      pid: 4815,
      lastExitStatus: 0,
    },
    capabilities: {
      update: 'unsupported',
      rollback: 'unsupported',
    },
    ...overrides,
  };
}
