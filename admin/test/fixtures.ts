import type { AdminOverview } from '../../src/skyd/types';
import type { ControlConfiguration } from '../../src/skyd/control';
import type { WorkspacePrompt, WorkspacePromptSnapshot } from '../../src/workspace-prompts';

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
