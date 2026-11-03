import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QA_ITEMS, QA_CATEGORIES, searchQa, normalizeText, countByCategory, validateDiagram, resolvePoint, legendKinds, courtSize,
  CATEGORY_LABEL, itemDiagrams,
} from '../js/qa.js';

test('場面は55件、ID は重複なし、カテゴリは決まったもの', () => {
  assert.equal(QA_ITEMS.length, 55);
  const ids = new Set(QA_ITEMS.map((i) => i.id));
  assert.equal(ids.size, 55);
  const cats = new Set(QA_CATEGORIES.map((c) => c.key));
  for (const it of QA_ITEMS) {
    assert.ok(cats.has(it.cat), `${it.id} のカテゴリ ${it.cat}`);
    assert.ok(it.title && it.situation, it.id);
    assert.ok(Array.isArray(it.points) && it.points.length >= 3, `${it.id} の対処の例が3つ未満`);
  }
  // どのカテゴリにも1件以上
  for (const [k, n] of Object.entries(countByCategory(QA_ITEMS))) assert.ok(n > 0, k);
});

test('利用者の例の2つの場面が入っている', () => {
  assert.ok(QA_ITEMS.some((i) => i.title.includes('2-2-1オールコートゾーン')));
  assert.ok(QA_ITEMS.some((i) => i.title.includes('プレッシャーがきつく') && i.title.includes('パス')));
  assert.ok(QA_ITEMS.some((i) => i.title.includes('1-2-2オールコートプレス')));
});

test('ハーフコートのゾーン（2-3・3-2・1-3-1）は対処の例が7つ以上', () => {
  for (const id of ['zone-23', 'zone-32', 'zone-131']) {
    assert.ok(QA_ITEMS.find((i) => i.id === id).points.length >= 7, id);
  }
});

test('フロントコートのセット：2点用と3点用が2つずつ、手順ごとの図つき', () => {
  const sets = QA_ITEMS.filter((i) => i.cat === 'sets');
  assert.equal(sets.filter((i) => i.title.startsWith('【2点】')).length, 2);
  assert.equal(sets.filter((i) => i.title.startsWith('【3点】')).length, 2);
  for (const it of sets) {
    assert.ok(it.steps.length >= 2, it.id);
    assert.ok(it.title.includes('残り10秒'), it.id);
    for (const st of it.steps) assert.ok(st.caption && st.diagram, it.id);
  }
});

test('文言：「TO」と略さない、「〜すべき」と書かない', () => {
  for (const it of QA_ITEMS) {
    const texts = [it.title, it.situation, ...it.points, ...(it.watch || []), ...itemDiagrams(it).map((d) => d.caption)];
    for (const t of texts) {
      assert.ok(!/TO/.test(t), `${it.id}: ${t}`);
      assert.ok(!/すべき/.test(t), `${it.id}: ${t}`);
    }
  }
});

test('図のデータに問題がない（座標・参照・矢印の種類）', () => {
  let withDiagram = 0;
  for (const it of QA_ITEMS) {
    const list = itemDiagrams(it);
    if (!list.length) continue;
    withDiagram += 1;
    for (const d of list) {
      assert.deepEqual(validateDiagram(d.diagram), [], it.id);
      assert.ok(d.caption, `${it.id} に図の説明がない`);
    }
  }
  assert.ok(withDiagram >= 30, `図のある場面は ${withDiagram} 件`);
});

test('図の検査は間違いを見つける', () => {
  const bad = {
    court: 'half',
    offense: [[7.5, 9, '1'], [30, 5, '2'], [1, 1, '1']],
    defense: [],
    ball: 'o9',
    arrows: [{ kind: 'jump', from: 'o1', to: 'x3' }],
  };
  const p = validateDiagram(bad);
  assert.ok(p.some((x) => x.includes('コートの外')));
  assert.ok(p.some((x) => x.includes('重複')));
  assert.ok(p.some((x) => x.includes('ball')));
  assert.ok(p.some((x) => x.includes('矢印の種類')));
  assert.ok(p.some((x) => x.includes('見つからない')));
  assert.deepEqual(validateDiagram(null), ['court は half か full']);
});

test('選手の参照と凡例', () => {
  const d = { court: 'full', offense: [[1, 2, '1']], defense: [[3, 4, '2']], arrows: [{ kind: 'pass', from: 'o1', to: [5, 5] }] };
  assert.deepEqual(resolvePoint(d, 'o1'), { x: 1, y: 2 });
  assert.deepEqual(resolvePoint(d, 'x2'), { x: 3, y: 4 });
  assert.equal(resolvePoint(d, 'x9'), null);
  assert.deepEqual(resolvePoint(d, [5, 6]), { x: 5, y: 6 });
  assert.deepEqual(legendKinds(d), ['offense', 'defense', 'pass']);
  assert.deepEqual(courtSize('full'), { w: 28, h: 15 });
  assert.deepEqual(courtSize('half'), { w: 15, h: 14 });
});

test('検索の文字そろえ（カタカナ・全角・ハイフン）', () => {
  assert.equal(normalizeText('プレス'), normalizeText('ぷれす'));
  assert.equal(normalizeText('２－２－１'), '2-2-1');
  assert.equal(normalizeText('  ゾーン　ディフェンス '), 'ぞーん でぃふぇんす');
});

test('検索：キーワード（すべて含む）・カテゴリ・お気に入り', () => {
  const press = searchQa(QA_ITEMS, { query: 'ぷれす' });
  assert.ok(press.length >= 5);
  // 本文かカテゴリ名に「プレス」を含むものだけ
  assert.ok(press.every((i) => /プレス/.test([i.title, i.situation, ...i.points, ...(i.watch || []), i.caption || '', CATEGORY_LABEL[i.cat]].join(''))));
  const z = searchQa(QA_ITEMS, { query: '２－３ ハイポスト' });
  assert.ok(z.some((i) => i.id === 'zone-23'));
  assert.equal(searchQa(QA_ITEMS, { category: 'rebound' }).length, countByCategory(QA_ITEMS).rebound);
  assert.deepEqual(searchQa(QA_ITEMS, { category: 'fav', favorites: ['man-pnr', 'zone-23'] }).map((i) => i.id), ['zone-23', 'man-pnr']);
  assert.equal(searchQa(QA_ITEMS, { query: 'そんなことばはない' }).length, 0);
  assert.equal(searchQa(QA_ITEMS).length, 55);
  assert.ok(searchQa(QA_ITEMS, { query: 'スタッガード' }).some((i) => i.id === 'set-3-stagger'));
});
