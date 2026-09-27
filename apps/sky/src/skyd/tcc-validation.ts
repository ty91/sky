import { randomUUID } from 'node:crypto';
import { constants, readFileSync, openSync, closeSync, fstatSync } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type { Configuration } from '../configuration.js';
import type { AgentSession } from '../agents/backend/types.js';
import type { RuntimeController } from '../runtime/controller.js';
import type { SkyHome } from '../sky-home.js';
import { ControlError } from './control.js';
import { createObservedValidationBackend } from './tcc-validation-backends.js';
import { resolveClaudeCodeExecutable } from '../claude-code-executable.js';

const directorySchema = z.string().max(1024).refine((value) =>
  path.isAbsolute(value) && !['\0', '\r', '\n'].some((character) => value.includes(character)) &&
  path.normalize(value) === value && path.basename(value) === 'sky-tcc-validation');
const configurationSchema = z.object({ fixtureDirectories: z.array(directorySchema).min(1).max(16) }).strict();
const requestSchema = z.object({
  route: z.enum(['host', 'file', 'bash']),
  operation: z.enum(['read', 'write']),
  directory: directorySchema,
}).strict();

export type TccValidation = {
  run(body: unknown, signal: AbortSignal): Promise<unknown>;
};

function loadConfiguration(file: string): z.infer<typeof configurationSchema> | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 8192) {
      throw new Error('TCC validation configuration must be an owned mode-0600 regular file of at most 8192 bytes.');
    }
    return configurationSchema.parse(JSON.parse(readFileSync(descriptor, 'utf8')));
  } finally {
    closeSync(descriptor);
  }
}

function describeError(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  return {
    category: code === 'EPERM' || code === 'EACCES' ? 'permission-denied'
      : code === 'ENOENT' ? 'missing' : 'other-error',
    code: typeof code === 'string' ? code : null,
    name: error instanceof Error ? error.name : 'UnknownError',
  };
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createTccValidation(options: {
  paths: SkyHome;
  configuration: Configuration;
  runtimeController: RuntimeController;
  createBackend?: typeof createObservedValidationBackend;
}): TccValidation | undefined {
  const config = loadConfiguration(path.join(options.paths.rootDir, 'tcc-validation.json'));
  if (!config) return undefined;
  let active = false;

  return {
    async run(body, callerSignal) {
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success || !config.fixtureDirectories.includes(parsed.data.directory)) {
        throw new ControlError('invalid_request');
      }
      if (active) throw new ControlError('operation_active');
      const lease = options.runtimeController.lease('agent_turn');
      if (!lease) throw new ControlError('daemon_draining');
      active = true;
      const request = parsed.data;
      const id = randomUUID();
      const nonce = randomUUID();
      const target = path.join(request.directory, request.operation === 'read' ? 'input.txt' : `output-${id}.txt`);
      const startedAt = new Date().toISOString();
      const signal = AbortSignal.any([
        callerSignal,
        options.runtimeController.drainingSignal,
        AbortSignal.timeout(180_000),
      ]);
      const evidence: unknown[] = [];
      let evidenceBytes = 0;
      let truncated = false;
      let session: AgentSession | undefined;
      let backend: string | null = null;
      let model: string | null = null;
      let outcome: unknown;
      let sessionFile: string | null = null;
      let removeAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        const abort = () => {
          void session?.abort().catch(() => {});
          session?.dispose();
          reject(new Error('TCC validation interrupted or timed out.'));
        };
        removeAbort = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
      const execute = async () => {
        signal.throwIfAborted();
        if (request.route === 'host') {
          if (request.operation === 'write') {
            await writeFile(target, nonce, { mode: 0o600, flag: 'wx', signal });
            return { status: 'access-succeeded', bytes: Buffer.byteLength(nonce) };
          }
          const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > 4096) throw new Error('Expected a fixture file of at most 4096 bytes.');
            const content = await file.readFile({ encoding: 'utf8', signal });
            return { status: 'access-succeeded', content };
          } finally {
            await file.close();
          }
        }
        const settings = options.configuration.resolveRuntime().settings;
        backend = settings.agentBackend;
        model = settings.model;
        const secrets = [settings.claudeAgentSdk?.oauthToken, process.env.CLAUDE_CODE_OAUTH_TOKEN,
          settings.slack.botToken, settings.slack.appToken].filter((value): value is string => Boolean(value));
        const record = (event: unknown) => {
          let serialized = JSON.stringify(event);
          for (const secret of secrets) serialized = serialized.replaceAll(secret, '[REDACTED]');
          evidenceBytes += Buffer.byteLength(serialized);
          if (evidenceBytes > 256 * 1024 || evidence.length >= 64) {
            truncated = true;
            return;
          }
          evidence.push({ at: new Date().toISOString(), event: JSON.parse(serialized) });
        };
        const createBackend = options.createBackend ?? createObservedValidationBackend;
        const factory = createBackend(settings, record);
        const tools = request.route === 'bash' ? ['Bash'] : [request.operation === 'read' ? 'Read' : 'Write'];
        session = await factory({
          key: `tcc-validation:${id}`,
          cwd: options.paths.rootDir,
          agent: {
            name: 'tcc-validation',
            model: settings.model,
            tools,
            maxTurns: 3,
            systemPrompt: 'Run the single requested fixture operation using the specified tool. Do not inspect other files, retry with other tools, request permission changes, or use background execution. Report the tool result without claiming an OS permission state.',
          },
        });
        if (signal.aborted) {
          session.dispose();
          signal.throwIfAborted();
        }
        sessionFile = session.resumeRef ?? null;
        const command = request.operation === 'read'
          ? `/bin/cat ${quoteShell(target)}`
          : `/usr/bin/printf %s ${quoteShell(nonce)} > ${quoteShell(target)}`;
        const prompt = request.route === 'bash'
          ? `Use Bash exactly once to run this foreground command: /bin/echo SKY_TCC_PID=$$ SKY_TCC_PPID=$PPID; /bin/sleep 5; ${command}`
          : request.operation === 'read'
            ? `Use Read exactly once on ${JSON.stringify(target)}. Do not use another tool.`
            : `Use Write exactly once to create ${JSON.stringify(target)} with exactly ${JSON.stringify(nonce)}. Do not use another tool.`;
        await session.prompt(prompt);
        return { status: 'turn-completed', requiresToolEvidenceReview: true };
      };
      const execution = execute().finally(() => {
        lease.release();
        active = false;
      });
      try {
        outcome = await Promise.race([execution, aborted]);
      } catch (error) {
        outcome = { status: 'execution-failed', ...describeError(error), interrupted: signal.aborted };
      } finally {
        removeAbort?.();
        session?.dispose();
      }
      return {
        schemaVersion: 1,
        id,
        startedAt,
        finishedAt: new Date().toISOString(),
        host: { pid: process.pid, ppid: process.ppid, executable: process.execPath, platform: process.platform, release: os.release(), arch: process.arch },
        backend,
        model,
        claudeExecutable: backend === 'claude-agent-sdk' ? resolveClaudeCodeExecutable() ?? null : null,
        request,
        target,
        ...(request.operation === 'write' ? { expectedContent: nonce } : {}),
        outcome,
        sessionFile,
        evidence,
        truncated,
        attribution: 'unverified',
      };
    },
  };
}
