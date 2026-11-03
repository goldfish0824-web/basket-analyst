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

/** その場面の図の一覧（1枚の図、または手順ごとの図） */
export function itemDiagrams(item) {
  if (Array.isArray(item.steps)) return item.steps.map((st) => ({ caption: st.caption, diagram: st.diagram }));
  return item.diagram ? [{ caption: item.caption || '', diagram: item.diagram }] : [];
}

function haystack(item) {
  return normalizeText([
    item.title, item.situation, ...(item.points || []), ...(item.watch || []), CATEGORY_LABEL[item.cat] || '',
    ...itemDiagrams(item).map((d) => d.caption),
  ].join(' '));
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
  for (const a of d.arrows || []) {
    if (!ARROW_KINDS.includes(a.kind)) problems.push(`矢印の種類 ${a.kind}`);
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
  return problems;
}

/** 図で使っている記号（凡例に出すもの） */
export function legendKinds(d) {
  const kinds = new Set();
  if ((d.offense || []).length) kinds.add('offense');
  if ((d.defense || []).length) kinds.add('defense');
  for (const a of d.arrows || []) kinds.add(a.kind);
  return ['offense', 'defense', ...ARROW_KINDS].filter((k) => kinds.has(k));
}
