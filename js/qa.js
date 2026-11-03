// 場面別Q&A の検索と、図のデータの検査。すべて純粋関数。
import { QA_CATEGORIES, QA_ITEMS } from './qa-data.js';

export { QA_CATEGORIES, QA_ITEMS };

export const CATEGORY_LABEL = Object.fromEntries(QA_CATEGORIES.map((c) => [c.key, c.label]));

export const ARROW_KINDS = ['move', 'pass', 'dribble', 'screen'];

/** 図の大きさ（m） */
export function courtSize(court) {
  return court === 'full' ? { w: 28, h: 15 } : { w: 15, h: 14 };
}

/**
 * 検索用に文字をそろえる：全角英数→半角、カタカナ→ひらがな、小文字、空白を詰める。
 * 「ぷれす」でも「プレス」、「２－２－１」でも「2-2-1」で見つかるように。
 */
export function normalizeText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[‐－―−ー]/g, (c) => (c === 'ー' ? 'ー' : '-'))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** 1つの図の単位（場面そのもの、またはパターン1つ）の図：1枚の図、または手順ごとの図 */
export function unitDiagrams(unit) {
  if (Array.isArray(unit.steps)) return unit.steps.map((st) => ({ caption: st.caption, diagram: st.diagram }));
  return unit.diagram ? [{ caption: unit.caption || '', diagram: unit.diagram }] : [];
}

/** その場面の図の一覧（パターンがあれば、すべてのパターンの図を順に） */
export function itemDiagrams(item) {
  if (Array.isArray(item.patterns)) return item.patterns.flatMap((p) => unitDiagrams(p));
  return unitDiagrams(item);
}

/** パターンの見出し（「パターン1」など） */
export function patternLabel(index) {
  return `パターン${index + 1}`;
}

function haystack(item) {
  const patterns = Array.isArray(item.patterns) ? item.patterns : [];
  return normalizeText([
    item.title, item.situation, ...(item.points || []), ...(item.watch || []), CATEGORY_LABEL[item.cat] || '',
    ...patterns.flatMap((p) => [p.name, ...(p.points || [])]),
    ...itemDiagrams(item).map((d) => d.caption),
  ].join(' '));
}

/**
 * 整理してまとめた場面の、前の ID → 今の ID（pattern はまとめた先のパターンの番号、0から）。
 * お気に入り・チームのメモ・古いリンクを引き継ぐために使う。
 */
export const QA_MOVED = {
  'press-8sec': { to: 'press-turnovers' },
  'press-break-finish': { to: 'tr-advantage', pattern: 1 },
  'zone-boxone': { to: 'man-ace', pattern: 1 },
  'zone-oreb': { to: 'reb-our-oreb' },
  'man-deny': { to: 'man-pressure', pattern: 1 },
  'def-23-weak': { to: 'def-23-basic' },
  'reb-tall': { to: 'reb-boxout' },
  'tr-outlet': { to: 'tr-3lane' },
  'tr-outnumbered': { to: 'tr-defense' },
  'game-teamfouls': { to: 'def-fouls' },
  'set-2-pnr': { to: 'set-2', pattern: 0 },
  'set-2-return': { to: 'set-2', pattern: 1 },
  'set-3-pindown': { to: 'set-3', pattern: 0 },
  'set-3-stagger': { to: 'set-3', pattern: 1 },
};

/** ID を今の場面に読み替える。{ id, pattern }（pattern は分からなければ null） */
export function resolveQaId(id, moved = QA_MOVED) {
  const m = moved[id];
  return m ? { id: m.to, pattern: Number.isInteger(m.pattern) ? m.pattern : null } : { id, pattern: null };
}

/**
 * お気に入りとチームのメモを、まとめた先の ID に移す（純粋関数）。
 * メモが両方にあるときは、空行をはさんでつなげる。changed は移したものがあったか。
 */
export function migrateQaSettings({ qaFavorites, qaNotes } = {}, moved = QA_MOVED) {
  const favIn = Array.isArray(qaFavorites) ? qaFavorites : [];
  const notesIn = qaNotes && typeof qaNotes === 'object' ? qaNotes : {};
  let changed = false;
  const fav = [];
  for (const id of favIn) {
    const next = resolveQaId(id, moved).id;
    if (next !== id) changed = true;
    if (!fav.includes(next)) fav.push(next);
    else changed = true;
  }
  const notes = {};
  for (const [id, text] of Object.entries(notesIn)) {
    const next = resolveQaId(id, moved).id;
    if (next !== id) changed = true;
    if (typeof text !== 'string' || !text.trim()) continue;
    notes[next] = notes[next] ? `${notes[next]}\n\n${text}` : text;
  }
  return { qaFavorites: fav, qaNotes: notes, changed };
}

/**
 * 絞り込み。
 * opts = { query, category: 'all'|'fav'|カテゴリ, favorites: [id] }
 * キーワードは空白区切りで、すべてを含むものを返す（並びは元の順）。
 */
export function searchQa(items, { query = '', category = 'all', favorites = [] } = {}) {
  const terms = normalizeText(query).split(' ').filter(Boolean);
  const fav = new Set(favorites);
  return items.filter((it) => {
    if (category === 'fav' && !fav.has(it.id)) return false;
    if (category !== 'all' && category !== 'fav' && it.cat !== category) return false;
    if (!terms.length) return true;
    const text = haystack(it);
    return terms.every((t) => text.includes(t));
  });
}

/** カテゴリごとの件数 */
export function countByCategory(items) {
  const counts = Object.fromEntries(QA_CATEGORIES.map((c) => [c.key, 0]));
  for (const it of items) if (counts[it.cat] != null) counts[it.cat] += 1;
  return counts;
}

/** 'o1' / 'x2' / [x, y] を座標にする。見つからなければ null */
export function resolvePoint(d, ref) {
  if (Array.isArray(ref)) return ref.length === 2 && ref.every(Number.isFinite) ? { x: ref[0], y: ref[1] } : null;
  const m = /^([ox])(\w+)$/.exec(String(ref || ''));
  if (!m) return null;
  const list = m[1] === 'o' ? d.offense || [] : d.defense || [];
  const p = list.find((q) => String(q[2]) === m[2]);
  return p ? { x: p[0], y: p[1] } : null;
}

/** 図のデータの問題点（なければ空の配列） */
export function validateDiagram(d) {
  const problems = [];
  if (!d || (d.court !== 'half' && d.court !== 'full')) return ['court は half か full'];
  const { w, h } = courtSize(d.court);
  const inRange = (p) => p && p.x >= -1 && p.x <= w + 1 && p.y >= -1 && p.y <= h + 1;
  for (const [name, list] of [['offense', d.offense], ['defense', d.defense]]) {
    if (!Array.isArray(list)) {
      problems.push(`${name} がない`);
      continue;
    }
    const labels = new Set();
    for (const p of list) {
      if (!inRange({ x: p[0], y: p[1] })) problems.push(`${name} ${p[2]} がコートの外`);
      if (labels.has(String(p[2]))) problems.push(`${name} ${p[2]} が重複`);
      labels.add(String(p[2]));
    }
  }
  if (d.ball && !resolvePoint(d, d.ball)) problems.push(`ball ${d.ball} が見つからない`);
  const orders = [];
  for (const a of d.arrows || []) {
    if (!ARROW_KINDS.includes(a.kind)) problems.push(`矢印の種類 ${a.kind}`);
    if (a.n != null) {
      if (!Number.isInteger(a.n) || a.n < 1 || a.n > 9) problems.push(`矢印の順番 ${a.n}`);
      else orders.push(a.n);
    }
    for (const key of ['from', 'to', 'via']) {
      if (key === 'via' && a.via == null) continue;
      const p = resolvePoint(d, a[key]);
      if (!p) problems.push(`矢印の ${key} ${JSON.stringify(a[key])} が見つからない`);
      else if (!inRange(p)) problems.push(`矢印の ${key} がコートの外`);
    }
  }
  for (const ar of d.areas || []) {
    if (!Array.isArray(ar.points) || ar.points.length < 3) problems.push('areas の点が足りない');
    else if (!ar.points.every((q) => inRange({ x: q[0], y: q[1] }))) problems.push('areas がコートの外');
  }
  for (const l of d.labels || []) {
    if (!inRange({ x: l.at[0], y: l.at[1] }) || !l.text) problems.push(`labels ${l.text}`);
  }
  for (const g of d.guides || []) {
    if (!resolvePoint(d, g.from) || !resolvePoint(d, g.to)) problems.push('guides の点');
  }
  // 順番の番号は 1 から抜けなく（同じ番号は「同時に」の意味で重なってよい）
  const uniq = [...new Set(orders)].sort((x, y) => x - y);
  if (uniq.some((n, i) => n !== i + 1)) problems.push(`矢印の順番が 1 から続いていない（${uniq.join(',')}）`);
  return problems;
}

/** 図で使っている記号（凡例に出すもの） */
export function legendKinds(d) {
  const kinds = new Set();
  if ((d.offense || []).length) kinds.add('offense');
  if ((d.defense || []).length) kinds.add('defense');
  for (const a of d.arrows || []) {
    kinds.add(a.kind);
    if (a.n != null) kinds.add('order');
  }
  return ['offense', 'defense', ...ARROW_KINDS, 'order'].filter((k) => kinds.has(k));
}
