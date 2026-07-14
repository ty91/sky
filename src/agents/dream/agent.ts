import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { AgentConfig } from '../types.js';
import type { ConversationManager } from '../../conversation/manager.js';
import {
  dateKeyKst,
  getYesterdayKey,
  koreanDayOfWeek,
  kstDayRangeUtc,
  nowIsoKst,
} from './date.js';
import { extractEntriesInRange, renderEntriesForPrompt, type TranscriptEntry } from './transcripts.js';
import { DREAM_SUMMARIZE_SYSTEM_PROMPT } from './prompt-summarize.js';
import { DREAM_KNOWLEDGE_SYSTEM_PROMPT } from './prompt-knowledge.js';

// L3 Dream Agent — see docs/plans/active/2026-04-20-memory-v2-phase3-dream.md
const DREAM_MODEL = 'anthropic/claude-opus-4-8';
// Step 1 gets Read/Glob/Grep for vault-context exploration even though the
// transcript itself is already injected into the user prompt. The overwrite
// policy is enforced at the runtime layer via preflight unlink, not via
// tool restriction.
const SUMMARIZE_TOOLS = ['Read', 'Write', 'Glob', 'Grep'] as const;
const KNOWLEDGE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;

export type DreamStep = 'summarize' | 'knowledge';

export type DreamAgentOptions = {
  conversationManager: ConversationManager;
  workspace: string;
  /** KST date key `YYYY-MM-DD`. Defaults to yesterday (KST). */
  targetDate?: string;
  /** Restrict to a single step (for debugging). Default runs both. */
  onlyStep?: DreamStep;
  /** Override the transcripts source directory (mostly for tests). */
  transcriptsDir?: string;
};

export type DreamAgentResult = {
  targetDate: string;
  entryCount: number;
  quietDay: boolean;
  summarize?: { ran: boolean; summary: string };
  knowledge?: { ran: boolean; summary: string };
};

function createSummarizeAgentConfig(workspace: string): AgentConfig {
  return {
    name: 'dream-summarize',
    systemPrompt: DREAM_SUMMARIZE_SYSTEM_PROMPT,
    model: DREAM_MODEL,
    tools: [...SUMMARIZE_TOOLS],
    cwd: workspace,
  };
}

function createKnowledgeAgentConfig(workspace: string): AgentConfig {
  return {
    name: 'dream-knowledge',
    systemPrompt: DREAM_KNOWLEDGE_SYSTEM_PROMPT,
    model: DREAM_MODEL,
    tools: [...KNOWLEDGE_TOOLS],
    cwd: workspace,
  };
}

function buildSummarizeUserPrompt(
  targetDate: string,
  entries: TranscriptEntry[],
  nowIso: string,
): string {
  const dayOfWeek = koreanDayOfWeek(targetDate);
  const header = [
    '# L3 Dream — Step 1: Daily Summarization',
    '',
    `**Target date (KST):** ${targetDate} (${dayOfWeek})`,
    `**Run time (KST):** ${nowIso}`,
    `**Target file:** \`memory/episodes/daily/${targetDate}.md\` (overwrite if exists)`,
    '',
  ];

  if (entries.length === 0) {
    header.push(
      '**No transcript entries found for this date.** Write the "조용한 하루" minimal template as specified in your system prompt.',
    );
    return header.join('\n');
  }

  header.push(
    `**${entries.length} transcript entries** for this day follow. Compose the daily summary ` +
      'per your system prompt (frontmatter + 5 sections). Overwrite the target file entirely.',
    '',
    '---',
    '',
    renderEntriesForPrompt(entries),
  );
  return header.join('\n');
}

function buildKnowledgeUserPrompt(
  targetDate: string,
  entries: TranscriptEntry[],
  nowIso: string,
): string {
  const header = [
    '# L3 Dream — Step 2: Knowledge Update',
    '',
    `**Target date (KST):** ${targetDate}`,
    `**Run time (KST):** ${nowIso}`,
    `**Daily file (written by Step 1):** \`memory/episodes/daily/${targetDate}.md\``,
    '',
    'Step 1 has just written the daily summary. Read it first, then consult the transcript ' +
      'below for any specific details you need before updating the long-term knowledge layers ' +
      '(people / projects / context / knowledge). Finally, append the audit trail to the ' +
      "bottom of today's daily file per your system prompt.",
    '',
    '---',
    '',
    entries.length === 0
      ? '_(No transcript entries — likely a quiet day. Step 1 already wrote the minimal template. ' +
        'Append an empty audit trail as specified.)_'
      : `**Transcript for ${targetDate} (${entries.length} entries) — reference as needed:**\n\n` +
        renderEntriesForPrompt(entries),
  ];
  return header.join('\n');
}

async function runSummarize(
  options: DreamAgentOptions,
  targetDate: string,
  entries: TranscriptEntry[],
  nowIso: string,
): Promise<string> {
  // Preflight: Claude's Write tool refuses to overwrite an existing file
  // unless Read was called first, but Step 1's tool set is intentionally
  // Write-only (the "overwrite without reading" policy). We enforce that
  // policy at the runtime layer by removing the target file ourselves so
  // the agent's Write always creates fresh.
  const targetPath = dreamDailyFilePath(options.workspace, targetDate);
  if (existsSync(targetPath)) {
    console.log(`[dream] removing existing ${targetPath} to honor overwrite policy`);
    unlinkSync(targetPath);
  }

  const key = 'dream:summarize';
  try {
    const userText = buildSummarizeUserPrompt(targetDate, entries, nowIso);
    const result = await options.conversationManager.runTurn(
      key,
      createSummarizeAgentConfig(options.workspace),
      userText,
    );
    if (result.kind === 'interrupted') {
      throw new Error('dream-summarize was unexpectedly interrupted');
    }
    if (result.kind === 'error') {
      throw new Error(`dream-summarize failed: ${result.error.message}`);
    }
    return result.text;
  } finally {
    await options.conversationManager.close(key);
  }
}

async function runKnowledge(
  options: DreamAgentOptions,
  targetDate: string,
  entries: TranscriptEntry[],
  nowIso: string,
): Promise<string> {
  const key = 'dream:knowledge';
  try {
    const userText = buildKnowledgeUserPrompt(targetDate, entries, nowIso);
    const result = await options.conversationManager.runTurn(
      key,
      createKnowledgeAgentConfig(options.workspace),
      userText,
    );
    if (result.kind === 'interrupted') {
      throw new Error('dream-knowledge was unexpectedly interrupted');
    }
    if (result.kind === 'error') {
      throw new Error(`dream-knowledge failed: ${result.error.message}`);
    }
    return result.text;
  } finally {
    await options.conversationManager.close(key);
  }
}

/**
 * Run the L3 Dream Agent once: summarize yesterday's transcripts into a daily
 * episode file, then curate the long-term knowledge vault based on the day.
 */
export async function runDreamAgent(options: DreamAgentOptions): Promise<DreamAgentResult> {
  const targetDate = options.targetDate ?? getYesterdayKey();
  const { startUtc, endUtc } = kstDayRangeUtc(targetDate);
  const entries = extractEntriesInRange(startUtc, endUtc, options.transcriptsDir);
  const nowIso = nowIsoKst();

  const today = dateKeyKst(new Date());
  console.log(`[dream] target=${targetDate} (now KST=${today}) entries=${entries.length}`);
  console.log(`[dream] range UTC=[${startUtc.toISOString()}, ${endUtc.toISOString()})`);

  const result: DreamAgentResult = {
    targetDate,
    entryCount: entries.length,
    quietDay: entries.length === 0,
  };

  const runSummarizeStep = options.onlyStep !== 'knowledge';
  const runKnowledgeStep = options.onlyStep !== 'summarize';

  if (runSummarizeStep) {
    console.log('[dream] step 1: summarize…');
    const summary = await runSummarize(options, targetDate, entries, nowIso);
    result.summarize = { ran: true, summary };
    console.log(`[dream] step 1 done: ${summary.slice(0, 200)}`);
  }

  if (runKnowledgeStep) {
    console.log('[dream] step 2: knowledge…');
    const summary = await runKnowledge(options, targetDate, entries, nowIso);
    result.knowledge = { ran: true, summary };
    console.log(`[dream] step 2 done: ${summary.slice(0, 200)}`);
  }

  return result;
}

/** Exported for CLI display. */
export function dreamDailyFilePath(workspace: string, targetDate: string): string {
  return path.join(workspace, 'memory', 'episodes', 'daily', `${targetDate}.md`);
}
