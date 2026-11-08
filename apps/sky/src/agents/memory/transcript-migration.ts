import { existsSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { inspectPrivateDirectory, type SkyHome } from '../../sky-home.js';
import { loadCursors, saveCursors } from './cursors.js';

export type TranscriptChatResolver = (chatId: string) => string | undefined;

type ChatMove = { from: string; to: string };

export function migrateTranscriptChats(skyHome: SkyHome, resolve: TranscriptChatResolver): number {
  const root = skyHome.transcriptsDir;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }

  const moves = names.flatMap((name): ChatMove[] => {
    const target = resolve(name);
    if (!target || target === name || !inspectPrivateDirectory(path.join(root, name))) return [];
    return [{ from: name, to: target }];
  });

  const cursors = loadCursors(skyHome);
  let added = false;
  for (const { from, to } of moves) {
    for (const [key, offset] of Object.entries(cursors)) {
      if (!key.startsWith(`${from}/`)) continue;
      const moved = `${to}/${key.slice(from.length + 1)}`;
      if (cursors[moved] !== undefined) continue;
      cursors[moved] = offset;
      added = true;
    }
  }
  if (added) saveCursors(cursors, skyHome);

  for (const move of moves) moveChat(root, move);

  const remaining = loadCursors(skyHome);
  let pruned = false;
  for (const key of Object.keys(remaining)) {
    const separator = key.indexOf('/');
    if (separator <= 0) continue;
    const chat = key.slice(0, separator);
    const file = key.slice(separator + 1);
    const target = resolve(chat);
    if (!target || target === chat) continue;
    if (existsSync(path.join(root, chat, file))) continue;
    if (remaining[`${target}/${file}`] === undefined) continue;
    delete remaining[key];
    pruned = true;
  }
  if (pruned) saveCursors(remaining, skyHome);

  return moves.length;
}

function moveChat(root: string, { from, to }: ChatMove): void {
  const source = path.join(root, from);
  const target = path.join(root, to);
  if (!existsSync(target)) {
    renameSync(source, target);
    return;
  }
  for (const file of readdirSync(source)) {
    const destination = path.join(target, file);
    if (!existsSync(destination)) renameSync(path.join(source, file), destination);
  }
  if (readdirSync(source).length === 0) rmdirSync(source);
}
