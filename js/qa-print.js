// 場面別Q&A の印刷（A4・両面・バインダー用）で、何をどの順に載せるかを決める。純粋関数。
// ・場面ごとに番号（No.1〜）を付け、カテゴリの順に並べる
// ・パターンのある場面は、すべてのパターンの図と動きを載せる
// ・左右を反対にできる場面（終盤のセット）は、左右反対の形も載せる
import { QA_ITEMS, QA_CATEGORIES, itemDiagrams, unitDiagrams, mirrorItem } from './qa.js';

/** 場面を1つずつ、載せる形（versions：通常と、左右反対） */
export function printPlan(items = QA_ITEMS, categories = QA_CATEGORIES) {
  const sections = [];
  let no = 0;
  for (const c of categories) {
    const list = items.filter((it) => it.cat === c.key);
    if (!list.length) continue;
    sections.push({
      key: c.key,
      label: c.label,
      items: list.map((item) => {
        no += 1;
        const versions = [{ label: '', item }];
        if (item.mirror === true) versions.push({ label: '左右を反対にした形', item: mirrorItem(item) });
        return { no, id: item.id, item, versions };
      }),
    });
  }
  return sections;
}

/** 場面の図の数（パターン・手順・左右反対をすべて数える） */
export function diagramCount(entry) {
  let n = 0;
  for (const v of entry.versions) {
    n += Array.isArray(v.item.patterns) ? v.item.patterns.reduce((s, p) => s + unitDiagrams(p).length, 0) : itemDiagrams(v.item).length;
  }
  return n;
}

/** 動きの説明の先頭の①〜⑨を、番号と本文に分ける */
export function splitMove(text) {
  const m = /^([①-⑨])(.*)$/u.exec(String(text));
  return m ? { n: m[1].charCodeAt(0) - 0x2460 + 1, text: m[2] } : { n: null, text: String(text) };
}
