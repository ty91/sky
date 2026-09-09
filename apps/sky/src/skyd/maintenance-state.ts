import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  inspectPrivateFile,
  type SkyHome,
} from '../sky-home.js';

type MaintenanceStateDocument = {
  schemaVersion: 1;
  dream: {
    lastSuccessfulTargetDate: string | null;
  };
};

export type MaintenanceStateStore = {
  loadOrBootstrap(workspace: string, latestDueDate: string): string | null;
  recordDreamSuccess(targetDate: string): void;
};

export class MaintenanceStateError extends Error {
  constructor(
    readonly code: 'maintenance_state_invalid' | 'maintenance_state_unsafe',
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MaintenanceStateError';
  }
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseDocument(value: unknown): MaintenanceStateDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MaintenanceStateError('maintenance_state_invalid', 'Maintenance state is invalid.');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.dream === null ||
    typeof candidate.dream !== 'object' ||
    Array.isArray(candidate.dream) ||
    Object.keys(candidate).some((key) => key !== 'schemaVersion' && key !== 'dream')
  ) {
    throw new MaintenanceStateError('maintenance_state_invalid', 'Maintenance state is invalid.');
  }
  const dream = candidate.dream as Record<string, unknown>;
  const targetDate = dream.lastSuccessfulTargetDate;
  if (
    (targetDate !== null && !isDateKey(targetDate)) ||
    Object.keys(dream).some((key) => key !== 'lastSuccessfulTargetDate') ||
    !Object.hasOwn(dream, 'lastSuccessfulTargetDate')
  ) {
    throw new MaintenanceStateError('maintenance_state_invalid', 'Maintenance state is invalid.');
  }
  return {
    schemaVersion: 1,
    dream: { lastSuccessfulTargetDate: targetDate },
  };
}

function translateUnsafe(error: unknown): never {
  if (error instanceof MaintenanceStateError) throw error;
  throw new MaintenanceStateError(
    'maintenance_state_unsafe',
    'Maintenance state could not be accessed safely.',
    error,
  );
}

function readDocument(file: string): MaintenanceStateDocument | undefined {
  try {
    if (!inspectPrivateFile(file)) return undefined;
  } catch (error) {
    translateUnsafe(error);
  }
  try {
    return parseDocument(JSON.parse(readFileSync(file, 'utf8')) as unknown);
  } catch (error) {
    if (error instanceof MaintenanceStateError) throw error;
    throw new MaintenanceStateError(
      'maintenance_state_invalid',
      'Maintenance state is invalid.',
      error,
    );
  }
}

function writeDocument(file: string, document: MaintenanceStateDocument): void {
  const directory = path.dirname(file);
  try {
    ensurePrivateDirectory(directory);
    inspectPrivateFile(file);
  } catch (error) {
    translateUnsafe(error);
  }

  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    ensurePrivateFile(file);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    translateUnsafe(error);
  }
}

function latestDailyEpisode(workspace: string, latestDueDate: string): string | null {
  const directory = path.join(workspace, 'memory', 'episodes', 'daily');
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.md') &&
          isDateKey(entry.name.slice(0, -3)) &&
          entry.name.slice(0, -3) <= latestDueDate,
      )
      .map((entry) => entry.name.slice(0, -3))
      .reduce<string | null>(
        (latest, dateKey) => (latest === null || dateKey > latest ? dateKey : latest),
        null,
      );
  } catch {
    return null;
  }
}

export function createMaintenanceStateStore(home: SkyHome): MaintenanceStateStore {
  return {
    loadOrBootstrap(workspace, latestDueDate) {
      if (!isDateKey(latestDueDate)) {
        throw new MaintenanceStateError(
          'maintenance_state_invalid',
          'The latest due dream date is invalid.',
        );
      }
      const existing = readDocument(home.maintenanceStateFile);
      if (
        existing?.dream.lastSuccessfulTargetDate !== null &&
        existing?.dream.lastSuccessfulTargetDate !== undefined &&
        existing.dream.lastSuccessfulTargetDate > latestDueDate
      ) {
        throw new MaintenanceStateError(
          'maintenance_state_invalid',
          'The dream maintenance watermark is later than the latest due date.',
        );
      }
      if (existing) return existing.dream.lastSuccessfulTargetDate;
      const lastSuccessfulTargetDate = latestDailyEpisode(workspace, latestDueDate);
      writeDocument(home.maintenanceStateFile, {
        schemaVersion: 1,
        dream: { lastSuccessfulTargetDate },
      });
      return lastSuccessfulTargetDate;
    },

    recordDreamSuccess(targetDate) {
      if (!isDateKey(targetDate)) {
        throw new MaintenanceStateError(
          'maintenance_state_invalid',
          'The successful dream target date is invalid.',
        );
      }
      const document = readDocument(home.maintenanceStateFile);
      if (!document) {
        throw new MaintenanceStateError(
          'maintenance_state_invalid',
          'Maintenance state must be initialized before recording dream success.',
        );
      }
      if (
        document.dream.lastSuccessfulTargetDate !== null &&
        document.dream.lastSuccessfulTargetDate > targetDate
      ) {
        throw new MaintenanceStateError(
          'maintenance_state_invalid',
          'Dream success cannot move the maintenance watermark backward.',
        );
      }
      if (document.dream.lastSuccessfulTargetDate === targetDate) return;
      writeDocument(home.maintenanceStateFile, {
        schemaVersion: 1,
        dream: { lastSuccessfulTargetDate: targetDate },
      });
    },
  };
}
