import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SKY_DIR } from '../../settings.js';

const CURSORS_FILE = path.join(SKY_DIR, 'memory-cursors.json');
const TRANSCRIPTS_DIR = path.join(SKY_DIR, 'transcripts');

/** Byte offset per transcript file (relative path from transcripts dir). */
type CursorMap = Record<string, number>;

function loadCursors(): CursorMap {
  try {
    return JSON.parse(readFileSync(CURSORS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCursors(cursors: CursorMap): void {
  mkdirSync(path.dirname(CURSORS_FILE), { recursive: true });
  writeFileSync(CURSORS_FILE, JSON.stringify(cursors, null, 2), 'utf8');
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
export function getUnreadTranscripts(): UnreadTranscript[] {
  const cursors = loadCursors();
  const results: UnreadTranscript[] = [];

  let chatDirs: string[];
  try {
    chatDirs = readdirSync(TRANSCRIPTS_DIR);
  } catch {
    return [];
  }

  for (const chatDir of chatDirs) {
    const chatPath = path.join(TRANSCRIPTS_DIR, chatDir);

    let files: string[];
    try {
      files = readdirSync(chatPath).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of files) {
      const absolutePath = path.join(chatPath, file);
      const relativePath = `${chatDir}/${file}`;

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
export function advanceCursors(transcripts: UnreadTranscript[]): void {
  const cursors = loadCursors();
  for (const t of transcripts) {
    cursors[t.relativePath] = t.newOffset;
  }
  saveCursors(cursors);
}
