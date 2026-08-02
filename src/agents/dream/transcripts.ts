import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  createSkyHome,
  inspectPrivateDirectory,
  inspectPrivateFile,
} from '../../sky-home.js';

export type TranscriptEntry = {
  chatId: string;
  sessionId: string;
  role: 'user' | 'assistant';
  /** ISO 8601 UTC timestamp as written in the transcript header. */
  timestampIso: string;
  timestamp: Date;
  text: string;
};

/**
 * Matches a single entry heading + body in the transcript format emitted by
 * `TranscriptWriter.formatEntry()`:
 *
 *     ### user (2026-04-19T07:30:00.000Z)
 *
 *     <body>
 *
 * The body runs until the next `### user|assistant` heading, or end of file.
 */
const ENTRY_REGEX =
  /^### (user|assistant) \((.+?)\)\n\n([\s\S]*?)(?=\n### (?:user|assistant) \(|$)/gm;

/** Parse a single transcript file into entries. */
export function parseTranscriptFile(
  chatId: string,
  sessionId: string,
  contents: string,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let match: RegExpExecArray | null;
  ENTRY_REGEX.lastIndex = 0;
  while ((match = ENTRY_REGEX.exec(contents)) !== null) {
    const [, roleRaw, timestampIso, bodyRaw] = match;
    const role = roleRaw === 'user' ? 'user' : 'assistant';
    const timestamp = new Date(timestampIso);
    if (Number.isNaN(timestamp.getTime())) continue;
    entries.push({
      chatId,
      sessionId,
      role,
      timestampIso,
      timestamp,
      text: bodyRaw.trimEnd(),
    });
  }
  return entries;
}

/**
 * Scan all transcript files under the selected Sky home's transcripts directory and return
 * entries whose timestamps fall in `[startUtc, endUtc)`, sorted chronologically.
 *
 * `transcriptsDir` is overrideable for tests.
 */
export function extractEntriesInRange(
  startUtc: Date,
  endUtc: Date,
  transcriptsDir: string = createSkyHome().transcriptsDir,
): TranscriptEntry[] {
  let chatDirs: string[];
  try {
    chatDirs = readdirSync(transcriptsDir);
  } catch {
    return [];
  }

  const all: TranscriptEntry[] = [];

  for (const chatId of chatDirs) {
    const chatPath = path.join(transcriptsDir, chatId);
    if (!inspectPrivateDirectory(chatPath)) continue;

    let files: string[];
    try {
      files = readdirSync(chatPath).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace(/\.md$/, '');
      const absolute = path.join(chatPath, file);
      if (!inspectPrivateFile(absolute)) continue;
      let contents: string;
      try {
        contents = readFileSync(absolute, 'utf8');
      } catch {
        continue;
      }
      const entries = parseTranscriptFile(chatId, sessionId, contents);
      for (const entry of entries) {
        if (entry.timestamp >= startUtc && entry.timestamp < endUtc) {
          all.push(entry);
        }
      }
    }
  }

  all.sort((a, b) => {
    const t = a.timestamp.getTime() - b.timestamp.getTime();
    if (t !== 0) return t;
    if (a.chatId !== b.chatId) return a.chatId < b.chatId ? -1 : 1;
    return a.sessionId < b.sessionId ? -1 : 1;
  });

  return all;
}

/** Render entries into a single markdown block suitable for injecting into a user prompt. */
export function renderEntriesForPrompt(entries: TranscriptEntry[]): string {
  const parts: string[] = [];
  for (const e of entries) {
    const kstTime = e.timestamp
      .toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' })
      .slice(11, 16); // "HH:MM"
    parts.push(`### ${e.role} [${kstTime} KST] (chat=${e.chatId}, session=${e.sessionId})`);
    parts.push('');
    parts.push(e.text);
    parts.push('');
  }
  return parts.join('\n');
}
