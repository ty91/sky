import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { CLAUDECLAW_DIR } from '../../settings.js';

const TRANSCRIPTS_DIR = path.join(CLAUDECLAW_DIR, 'transcripts');

type BufferedEntry = { role: 'user' | 'assistant'; text: string; timestamp: string };

function nowIso(): string {
  return new Date().toISOString();
}

function formatEntry(entry: BufferedEntry): string {
  return `### ${entry.role} (${entry.timestamp})\n\n${entry.text}\n\n`;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export class TranscriptWriter {
  private readonly chatId: string;
  private sessionId: string | undefined;
  private readonly buffer: BufferedEntry[] = [];
  private flushed = false;

  constructor(chatId: string) {
    this.chatId = chatId;
  }

  setSessionId(sessionId: string): void {
    if (this.sessionId === sessionId) return;

    this.sessionId = sessionId;
    this.flush();
  }

  appendUser(text: string): void {
    this.append({ role: 'user', text, timestamp: nowIso() });
  }

  appendAssistant(text: string): void {
    this.append({ role: 'assistant', text, timestamp: nowIso() });
  }

  private append(entry: BufferedEntry): void {
    if (this.sessionId) {
      this.writeToFile(formatEntry(entry));
    } else {
      this.buffer.push(entry);
    }
  }

  private flush(): void {
    if (this.flushed || this.buffer.length === 0) return;

    const content = this.buffer.map(formatEntry).join('');
    this.writeToFile(content);
    this.buffer.length = 0;
    this.flushed = true;
  }

  private writeToFile(content: string): void {
    const dir = path.join(TRANSCRIPTS_DIR, this.chatId);
    ensureDir(dir);

    const filePath = path.join(dir, `${this.sessionId}.md`);
    appendFileSync(filePath, content, 'utf8');
  }
}
