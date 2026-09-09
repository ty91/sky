import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createSkyHome,
  ensurePrivateDirectory,
  ensurePrivateFile,
  inspectPrivateDirectory,
  inspectPrivateFile,
  type SkyHome,
} from '../../sky-home.js';

/** Byte offset per transcript file (relative path from transcripts dir). */
type CursorMap = Record<string, number>;

function loadCursors(skyHome: SkyHome): CursorMap {
  try {
    ensurePrivateFile(skyHome.memoryCursorFile);
    return JSON.parse(readFileSync(skyHome.memoryCursorFile, 'utf8'));
  } catch {
    return {};
  }
}

function saveCursors(cursors: CursorMap, skyHome: SkyHome): void {
  ensurePrivateDirectory(skyHome.rootDir);
  ensurePrivateFile(skyHome.memoryCursorFile);
  writeFileSync(skyHome.memoryCursorFile, JSON.stringify(cursors, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  ensurePrivateFile(skyHome.memoryCursorFile);
}

export type UnreadTranscript = {
  /** Relative path from transcripts dir, e.g. "123456/abc-def.md" */
  relativePath: string;
  /** Absolute path */
  absolutePath: string;
  /** New content since last cursor position */
  newContent: string;
  /** Byte offset to advance cursor to after processing */
  newOffset: number;
};

/**
 * Scan all transcript files and return those with unread content.
 */
export function getUnreadTranscripts(skyHome: SkyHome = createSkyHome()): UnreadTranscript[] {
  const cursors = loadCursors(skyHome);
  const results: UnreadTranscript[] = [];

  let chatDirs: string[];
  try {
    chatDirs = readdirSync(skyHome.transcriptsDir);
  } catch {
    return [];
  }

  for (const chatDir of chatDirs) {
    const chatPath = path.join(skyHome.transcriptsDir, chatDir);
    if (!inspectPrivateDirectory(chatPath)) continue;
    const files = readdirSync(chatPath).filter((f) => f.endsWith('.md'));

    for (const file of files) {
      const absolutePath = path.join(chatPath, file);
      const relativePath = `${chatDir}/${file}`;
      if (!inspectPrivateFile(absolutePath)) continue;

      let fileSize: number;
      try {
        fileSize = statSync(absolutePath).size;
      } catch {
        continue;
      }

      const cursor = cursors[relativePath] ?? 0;
      if (fileSize <= cursor) continue;

      // Read full file then slice from cursor byte offset
      const fullBuffer = readFileSync(absolutePath);
      const newContent = fullBuffer.subarray(cursor).toString('utf8');

      if (newContent.trim().length === 0) continue;

      results.push({
        relativePath,
        absolutePath,
        newContent,
        newOffset: fileSize,
      });
    }
  }

  return results;
}

/**
 * Advance cursors for the given transcripts (call after successful processing).
 */
export function advanceCursors(
  transcripts: UnreadTranscript[],
  skyHome: SkyHome = createSkyHome(),
): void {
  const cursors = loadCursors(skyHome);
  for (const t of transcripts) {
    cursors[t.relativePath] = t.newOffset;
  }
  saveCursors(cursors, skyHome);
}
