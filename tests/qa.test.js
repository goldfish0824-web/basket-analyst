import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QA_ITEMS, QA_CATEGORIES, searchQa, normalizeText, countByCategory, validateDiagram, resolvePoint, legendKinds, courtSize,
  CATEGORY_LABEL, itemDiagrams, unitDiagrams, patternLabel, QA_MOVED, resolveQaId, migrateQaSettings,
  mirrorText, mirrorDiagram, mirrorItem,
} from '../js/qa.js';

const byId = (id) => QA_ITEMS.find((i) => i.id === id);

test('場面は42件（重なりを整理）、ID は重複なし、カテゴリは決まったもの', () => {
  assert.equal(QA_ITEMS.length, 42);
  const ids = new Set(QA_ITEMS.map((i) => i.id));
  assert.equal(ids.size, 42);
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

test('ハーフコートのゾーン（2-3・3-2・1-3-1）は、攻め方ごとのパターンと図（順番の札つき）を持つ', () => {
  const min = { 'zone-23': 5, 'zone-32': 4, 'zone-131': 3 };
  for (const [id, n] of Object.entries(min)) {
    const it = byId(id);
    assert.ok(it.patterns.length >= n, `${id} のパターン ${it.patterns.length}`);
    for (const p of it.patterns) {
      const ds = unitDiagrams(p);
      assert.equal(ds.length, 1, `${id} ${p.name}`);
      assert.equal(ds[0].diagram.court, 'half');
      assert.ok(ds[0].diagram.arrows.some((a) => a.n === 1), `${id} ${p.name} の順番`);
      assert.ok(p.points[0].startsWith('①'), `${id} ${p.name}`);
    }
  }
});

test('フロントコートのセット：2点用・3点用の2場面に、パターンが2つずつ（手順ごとの図つき）', () => {
  const sets = QA_ITEMS.filter((i) => i.cat === 'sets');
  assert.deepEqual(sets.map((i) => i.id), ['set-2', 'set-3']);
  assert.ok(sets[0].title.startsWith('【2点】'));
  assert.ok(sets[1].title.startsWith('【3点】'));
  for (const it of sets) {
    assert.ok(it.title.includes('試合終盤'), it.id);
    assert.equal(it.patterns.length, 2, it.id);
    for (const p of it.patterns) {
      assert.ok(p.steps.length >= 2, `${it.id} ${p.name}`);
      for (const st of p.steps) assert.ok(st.caption && st.diagram, it.id);
    }
  }
});

test('オールコートのゾーンプレス（2-2-1・1-2-1-1・1-2-2）は、パターン1〜3を図つきで持つ', () => {
  for (const id of ['press-221', 'press-1211', 'press-122']) {
    const it = byId(id);
    assert.equal(it.patterns.length, 3, id);
    const names = new Set();
    for (const p of it.patterns) {
      assert.ok(p.name && !names.has(p.name), `${id} の名前`);
      names.add(p.name);
      assert.ok(p.points.length >= 2, `${id} ${p.name} の動き`);
      const ds = unitDiagrams(p);
      assert.equal(ds.length, 1, `${id} ${p.name} の図`);
      assert.equal(ds[0].diagram.court, 'full');
      assert.ok(ds[0].caption);
      // 図の矢印には順番の札があり、動きの説明の ① から始まる
      assert.ok(ds[0].diagram.arrows.some((a) => a.n === 1), `${id} ${p.name} の順番`);
      assert.ok(p.points[0].startsWith('①'), `${id} ${p.name}`);
    }
  }
  assert.equal(patternLabel(0), 'パターン1');
  assert.equal(patternLabel(2), 'パターン3');
});

test('パターンのある場面：図の一覧はすべてのパターンの図を順に並べる', () => {
  const it = byId('set-2');
  const all = itemDiagrams(it);
  assert.equal(all.length, it.patterns.reduce((n, p) => n + p.steps.length, 0));
  assert.equal(all[0].caption, it.patterns[0].steps[0].caption);
  assert.equal(itemDiagrams(byId('press-221')).length, 3);
  assert.equal(itemDiagrams(byId('zone-23')).length, 5);
  assert.equal(itemDiagrams(byId('man-post-entry')).length, 1);
  assert.equal(itemDiagrams(byId('sp-last')).length, 0);
});

test('文言：「TO」と略さない、「〜すべき」と書かない', () => {
  for (const it of QA_ITEMS) {
    const texts = [
      it.title, it.situation, ...it.points, ...(it.watch || []), ...itemDiagrams(it).map((d) => d.caption),
      ...(it.patterns || []).flatMap((p) => [p.name, ...p.points]),
    ];
    for (const t of texts) {
      assert.ok(!/TO/.test(t), `${it.id}: ${t}`);
      assert.ok(!/すべき/.test(t), `${it.id}: ${t}`);
    }
  }
});

test('図のデータに問題がない（座標・参照・矢印の種類）', () => {
  let withDiagram = 0;
  let total = 0;
  for (const it of QA_ITEMS) {
    const list = itemDiagrams(it);
    if (!list.length) continue;
    withDiagram += 1;
    total += list.length;
    for (const d of list) {
      assert.deepEqual(validateDiagram(d.diagram), [], it.id);
      assert.ok(d.caption, `${it.id} に図の説明がない`);
    }
  }
  assert.ok(withDiagram >= 27, `図のある場面は ${withDiagram} 件`);
  assert.ok(total >= 52, `図は ${total} 枚`);
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
  // 順番の札：1 から抜けなく（同じ番号は同時の動き）
  const ok = { court: 'half', offense: [[1, 1, '1']], defense: [], arrows: [
    { kind: 'pass', from: 'o1', to: [3, 3], n: 1 }, { kind: 'move', from: 'o1', to: [4, 4], n: 2 }, { kind: 'move', from: [4, 4], to: [5, 5], n: 2 }] };
  assert.deepEqual(validateDiagram(ok), []);
  const gap = { ...ok, arrows: [{ kind: 'pass', from: 'o1', to: [3, 3], n: 1 }, { kind: 'pass', from: 'o1', to: [4, 4], n: 3 }] };
  assert.ok(validateDiagram(gap).some((x) => x.includes('順番')));
  const zero = { ...ok, arrows: [{ kind: 'pass', from: 'o1', to: [3, 3], n: 0 }] };
  assert.ok(validateDiagram(zero).some((x) => x.includes('順番')));
});

test('選手の参照と凡例', () => {
  const d = { court: 'full', offense: [[1, 2, '1']], defense: [[3, 4, '2']], arrows: [{ kind: 'pass', from: 'o1', to: [5, 5] }] };
  assert.deepEqual(resolvePoint(d, 'o1'), { x: 1, y: 2 });
  assert.deepEqual(resolvePoint(d, 'x2'), { x: 3, y: 4 });
  assert.equal(resolvePoint(d, 'x9'), null);
  assert.deepEqual(resolvePoint(d, [5, 6]), { x: 5, y: 6 });
  assert.deepEqual(legendKinds(d), ['offense', 'defense', 'pass']);
  assert.deepEqual(legendKinds({ ...d, arrows: [{ kind: 'pass', from: 'o1', to: [5, 5], n: 1 }] }), ['offense', 'defense', 'pass', 'order']);
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
  assert.ok(searchQa(QA_ITEMS, { query: 'ギャップ' }).some((i) => i.id === 'zone-23'));
  assert.ok(z.some((i) => i.id === 'zone-23'));
  assert.equal(searchQa(QA_ITEMS, { category: 'rebound' }).length, countByCategory(QA_ITEMS).rebound);
  assert.deepEqual(searchQa(QA_ITEMS, { category: 'fav', favorites: ['man-pnr', 'zone-23'] }).map((i) => i.id), ['zone-23', 'man-pnr']);
  assert.equal(searchQa(QA_ITEMS, { query: 'そんなことばはない' }).length, 0);
  assert.equal(searchQa(QA_ITEMS).length, 42);
  // パターンの名前・動きも探せる
  assert.ok(searchQa(QA_ITEMS, { query: 'スタッガード' }).some((i) => i.id === 'set-3'));
  assert.deepEqual(searchQa(QA_ITEMS, { query: 'ドリブルで割る' }).map((i) => i.id), ['press-221']);
  assert.ok(searchQa(QA_ITEMS, { query: 'ボックスワン' }).some((i) => i.id === 'man-ace'));
  assert.ok(searchQa(QA_ITEMS, { query: '8秒' }).some((i) => i.id === 'press-turnovers'));
});

test('まとめた場面：前の ID はなく、まとめた先はある', () => {
  const ids = new Set(QA_ITEMS.map((i) => i.id));
  for (const [from, m] of Object.entries(QA_MOVED)) {
    assert.ok(!ids.has(from), `${from} が残っている`);
    assert.ok(ids.has(m.to), `${m.to} がない`);
    if (m.pattern != null) assert.ok(byId(m.to).patterns[m.pattern], `${from} → ${m.to} のパターン ${m.pattern}`);
  }
  assert.deepEqual(resolveQaId('set-2-return'), { id: 'set-2', pattern: 1 });
  assert.deepEqual(resolveQaId('press-8sec'), { id: 'press-turnovers', pattern: null });
  assert.deepEqual(resolveQaId('zone-23'), { id: 'zone-23', pattern: null });
});

test('お気に入りとチームのメモを、まとめた先へ移す', () => {
  const r = migrateQaSettings({
    qaFavorites: ['set-2-pnr', 'zone-23', 'set-2-return', 'reb-tall'],
    qaNotes: { 'reb-tall': '4番に2人で当たる', 'reb-boxout': '全員で当たる', 'man-deny': '  ', 'zone-23': '1-3-1で' },
  });
  assert.equal(r.changed, true);
  assert.deepEqual(r.qaFavorites, ['set-2', 'zone-23', 'reb-boxout']);
  assert.deepEqual(r.qaNotes, { 'reb-boxout': '4番に2人で当たる\n\n全員で当たる', 'zone-23': '1-3-1で' });
  // 移すものがなければ変わらない
  const same = migrateQaSettings({ qaFavorites: ['zone-23'], qaNotes: { 'zone-23': 'メモ' } });
  assert.equal(same.changed, false);
  assert.deepEqual(same.qaFavorites, ['zone-23']);
  // 設定がなくても動く
  assert.deepEqual(migrateQaSettings({}), { qaFavorites: [], qaNotes: {}, changed: false });
});

test('【2点】のパターン1（ピック＆ロール）は右手のドリブルで中央へ（左ウイングから右へ）', () => {
  const p = byId('set-2').patterns[0];
  const drive = p.steps[1].diagram.arrows.find((a) => a.kind === 'dribble');
  const start = p.steps[1].diagram.offense.find((q) => q[2] === '1');
  assert.ok(drive.to[0] > start[0], 'ドリブルが左から右（中央）へ向かっていない');
  assert.ok(p.points.some((x) => x.includes('右手のドリブル')));
});

test('左右の入れ替え：説明文（「左右」はそのまま）', () => {
  assert.equal(mirrorText('左サイドから。1は右手のドリブル（左右反対の形）'), '右サイドから。1は左手のドリブル（左右反対の形）');
  assert.equal(mirrorText('ボール側（左）のウイング、逆サイド（右）のコーナー'), 'ボール側（右）のウイング、逆サイド（左）のコーナー');
  assert.equal(mirrorText('ハイポスト'), 'ハイポスト');
  // 2回で元に戻る
  const t = '左ウイングで受け、右手で左へ';
  assert.equal(mirrorText(mirrorText(t)), t);
});

test('左右の入れ替え：図（ハーフは x、オールは y）。元のデータは変えない', () => {
  const d = {
    court: 'half', offense: [[2, 3, '1']], defense: [[4, 4, '1']], ball: 'o1',
    arrows: [{ kind: 'pass', from: 'o1', to: [4, 5], via: [3, 3], n: 1 }, { kind: 'move', from: 'x1', to: 'o1' }],
    labels: [{ at: [1, 1], text: '左ウイング' }], areas: [{ points: [[0, 0], [1, 0], [1, 1]], label: 'わな' }],
    guides: [{ from: [7.5, 0], to: [7.5, 12] }],
  };
  const m = mirrorDiagram(d);
  assert.deepEqual(m.offense, [[13, 3, '1']]);
  assert.deepEqual(m.defense, [[11, 4, '1']]);
  assert.deepEqual(m.arrows[0], { kind: 'pass', from: 'o1', to: [11, 5], via: [12, 3], n: 1 });
  assert.deepEqual(m.arrows[1], { kind: 'move', from: 'x1', to: 'o1' });
  assert.deepEqual(m.labels, [{ at: [14, 1], text: '右ウイング' }]);
  assert.deepEqual(m.areas[0].points, [[15, 0], [14, 0], [14, 1]]);
  assert.deepEqual(m.guides[0], { from: [7.5, 0], to: [7.5, 12] });
  assert.deepEqual(d.offense, [[2, 3, '1']], '元のデータが変わった');
  assert.deepEqual(mirrorDiagram(m), d);
  const f = mirrorDiagram({ court: 'full', offense: [[3, 2, '1']], defense: [], arrows: [] });
  assert.deepEqual(f.offense, [[3, 13, '1']]);
});

test('終盤のセットは「左右を反対にする」ができ、図と説明文がそろって入れ替わる', () => {
  for (const id of ['set-2', 'set-3']) {
    const it = byId(id);
    assert.equal(it.mirror, true, id);
    const m = mirrorItem(it);
    assert.equal(m.title, it.title);
    assert.equal(m.patterns.length, it.patterns.length);
    for (const d of itemDiagrams(m)) assert.deepEqual(validateDiagram(d.diagram), [], id);
    assert.deepEqual(mirrorItem(m).patterns, it.patterns, `${id} は2回で元に戻る`);
  }
  // パターン1（ピック＆ロール）：反対にすると右サイドから、左手のドリブル
  const p = mirrorItem(byId('set-2')).patterns[0];
  assert.ok(p.points[0].startsWith('図は右サイドからのスローインで、1が左手でドリブル'));
  assert.ok(p.steps[0].caption.includes('右ウイング'));
  const drive = p.steps[1].diagram.arrows.find((a) => a.kind === 'dribble');
  const start = p.steps[1].diagram.offense.find((q) => q[2] === '1');
  assert.ok(drive.to[0] < start[0], 'ドリブルが右から左（中央）へ向かっていない');
  // スローインする3は、反対にすると左サイドの外
  assert.ok(byId('set-3').patterns[0].steps[0].diagram.offense.find((q) => q[2] === '3')[0] > 15);
  assert.ok(mirrorItem(byId('set-3')).patterns[0].steps[0].diagram.offense.find((q) => q[2] === '3')[0] < 0);
});

