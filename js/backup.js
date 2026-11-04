// JSON の書き出し・読み込み（SPEC 1章 バックアップ）。形の組み立てと検査は純粋関数。
import { EVENT_TYPES } from './model.js';

export const BACKUP_APP = 'basket-analyst';
export const BACKUP_FORMAT = 1;

/**
 * 書き出す形を作る。settings を渡したときだけ設定も含める（全データの書き出し）。
 */
export function buildBackup({ games, events, settings }, now = Date.now()) {
  const out = {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    exportedAt: new Date(now).toISOString(),
    games: games.map((g) => ({ ...g })),
    events: events.map((e) => ({ ...e })),
  };
  if (settings) out.settings = { ...settings };
  return out;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30);
}

export function backupFileName(games, now = Date.now()) {
  const d = new Date(now);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  if (games.length === 1) {
    const g = games[0];
    return `basket-${(g.date || '').replace(/-/g, '')}-${safeName(g.opponent) || 'game'}.json`;
  }
  return `basket-all-${stamp}.json`;
}

/**
 * 読み込んだ文字列を検査して { games, events, settings, skipped } を返す。
 * 形が違うときは日本語のメッセージで Error を投げる。
 */
export function parseBackup(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new Error('JSONとして読めません。書き出したファイルを選んでください。');
  }
  if (!data || typeof data !== 'object' || data.app !== BACKUP_APP) {
    throw new Error('このアプリで書き出したバックアップではありません。');
  }
  if (typeof data.format !== 'number' || data.format > BACKUP_FORMAT) {
    throw new Error('新しい版のアプリで書き出されたファイルです。アプリを更新してから読み込んでください。');
  }
  if (!Array.isArray(data.games) || !Array.isArray(data.events)) {
    throw new Error('試合データが入っていません。');
  }
  const games = [];
  for (const g of data.games) {
    if (!g || typeof g.id !== 'string' || !g.id) throw new Error('試合のIDがないデータがあります。');
    games.push({
      checklist: [],
      insights: [],
      advice: [],
      videos: [],
      oppNumbers: [],
      roster: [],
      ...g,
    });
  }
  const ids = new Set(games.map((g) => g.id));
  const types = new Set(EVENT_TYPES);
  const events = [];
  let skipped = 0;
  for (const e of data.events) {
    if (!e || typeof e.id !== 'string' || !ids.has(e.gameId) || !types.has(e.type) || typeof e.seq !== 'number') {
      skipped += 1;
      continue;
    }
    events.push({ ...e, tags: Array.isArray(e.tags) ? e.tags : [] });
  }
  const settings = data.settings && typeof data.settings === 'object' ? data.settings : null;
  return { games, events, settings, skipped };
}
