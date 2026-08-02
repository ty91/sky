import { appendFileSync } from 'node:fs';
import {
  createSkyHome,
  ensurePrivateDirectory,
  ensurePrivateFile,
  transcriptDirectory,
  transcriptFile,
  type SkyHome,
} from '../../sky-home.js';

type BufferedEntry = { role: 'user' | 'assistant'; text: string; timestamp: string };

function nowIso(): string {
  return new Date().toISOString();
}

function formatEntry(entry: BufferedEntry): string {
  return `### ${entry.role} (${entry.timestamp})\n\n${entry.text}\n\n`;
}

export class TranscriptWriter {
  private readonly chatId: string;
  private readonly skyHome: SkyHome;
  private sessionId: string | undefined;
  private readonly buffer: BufferedEntry[] = [];
  private flushed = false;

  constructor(chatId: string, skyHome: SkyHome = createSkyHome()) {
    this.chatId = chatId;
    this.skyHome = skyHome;
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
    const dir = transcriptDirectory(this.skyHome, this.chatId);
    ensurePrivateDirectory(this.skyHome.transcriptsDir);
    ensurePrivateDirectory(dir);

    const filePath = transcriptFile(this.skyHome, this.chatId, this.sessionId ?? '');
    ensurePrivateFile(filePath);
    appendFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
    ensurePrivateFile(filePath);
  }
}
