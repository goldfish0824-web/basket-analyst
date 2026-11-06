import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialInput, step, hintFor } from '../js/input.js';

function run(cmds, opts = {}) {
  let n = 0;
  const ctx = { newId: () => `id${++n}`, isDisabled: opts.isDisabled };
  let state = opts.state || initialInput();
  const ops = [];
  const errors = [];
  for (const c of cmds) {
    const r = step(state, c, ctx);
    state = r.state;
    ops.push(...r.ops);
    if (r.error) errors.push(r.error);
  }
  return { state, ops, errors };
}

const adds = (ops) => ops.filter((o) => o.op === 'add').map((o) => o.draft);

test('フィールドゴール：コート → 選手 → 成功 の3タップ', () => {
  const r = run([
    { type: 'court', x: 12, y: 3 },
    { type: 'player', team: 'us', player: '7' },
    { type: 'fgResult', made: true },
  ]);
  const [d] = adds(r.ops);
  assert.equal(d.type, 'fg');
  assert.equal(d.team, 'us');
  assert.equal(d.player, '7');
  assert.equal(d.made, true);
  assert.equal(d.points, 2);
  assert.equal(d.zone, 'ミドル右');
  // 記録後は種類タグ（任意）を出す
  assert.equal(r.state.sheet, 'tags');
  assert.equal(r.state.tagEventId, d.id);
  assert.equal(r.state.loc, null);
  assert.equal(r.state.sel, null);
});

test('フィールドゴール：選手を先に選んでからコートでもよい', () => {
  const r = run([
    { type: 'player', team: 'us', player: '4' },
    { type: 'court', x: 7.5, y: 9 },
  ]);
  assert.equal(r.state.sheet, 'fg');
  assert.equal(r.state.three, true);
  const r2 = run([{ type: 'fgResult', made: false }], { state: r.state });
  const [d] = adds(r2.ops);
  assert.deepEqual([d.player, d.points, d.made, d.zone], ['4', 3, false, '3Pトップ']);
});

test('2P⇄3P の切り替えで点数とゾーンが変わる', () => {
  const r = run([
    { type: 'court', x: 7.5, y: 8.2 }, // ライン少し内側
    { type: 'player', team: 'opp', player: '12' },
    { type: 'toggle3' },
    { type: 'fgResult', made: true },
  ]);
  const [d] = adds(r.ops);
  assert.equal(d.points, 3);
  assert.equal(d.zone, '3Pトップ');
});

test('種類タグは記録済みのシュートに付け外しできる', () => {
  const r = run([
    { type: 'court', x: 12, y: 3 },
    { type: 'player', team: 'us', player: '7' },
    { type: 'fgResult', made: true },
    { type: 'tag', tag: 'ドライブ' },
    { type: 'tag', tag: '速攻' },
    { type: 'tag', tag: 'ドライブ' },
  ]);
  const patches = r.ops.filter((o) => o.op === 'patch');
  assert.equal(patches.length, 3);
  assert.deepEqual(patches[2], { op: 'patch', id: 'id1', patch: { tags: ['速攻'] } });
});

test('種類タグはスキップできる（次の操作で閉じる）', () => {
  const r = run([
    { type: 'court', x: 12, y: 3 },
    { type: 'player', team: 'us', player: '7' },
    { type: 'fgResult', made: false },
    { type: 'play', action: 'dreb' },
    { type: 'team', team: 'opp' },
    { type: 'player', team: 'opp', player: null },
  ]);
  const d = adds(r.ops);
  assert.equal(d.length, 2);
  assert.deepEqual([d[1].type, d[1].team, d[1].player], ['dreb', 'opp', null]);
  assert.equal(r.state.sheet, null);
});

test('フリースロー：選手 → FT成功', () => {
  const r = run([
    { type: 'player', team: 'us', player: '5' },
    { type: 'play', action: 'ft_made' },
  ]);
  const [d] = adds(r.ops);
  assert.deepEqual([d.type, d.made, d.points, d.player], ['ft', true, 1, '5']);
  assert.equal(r.state.sel, null); // 続けて押しても二重に記録されない
});

test('リバウンド：DR → 選手 の順でも記録できる', () => {
  const r = run([
    { type: 'play', action: 'dreb' },
    { type: 'player', team: 'us', player: '6' },
  ]);
  const [d] = adds(r.ops);
  assert.deepEqual([d.type, d.team, d.player], ['dreb', 'us', '6']);
});

test('リバウンド：自チームは「チーム」（選手なし）も可', () => {
  const r = run([
    { type: 'play', action: 'oreb' },
    { type: 'player', team: 'us', player: null },
  ]);
  assert.deepEqual(adds(r.ops).map((d) => [d.type, d.player]), [['oreb', null]]);
});

test('自チームのファウル・FTは選手なしでは記録しない', () => {
  const r = run([
    { type: 'play', action: 'foul' },
    { type: 'player', team: 'us', player: null },
  ]);
  assert.equal(adds(r.ops).length, 0);
  assert.equal(r.errors.length, 1);
  assert.equal(r.state.action, 'foul'); // 続けて選手を選べば記録できる
  const r2 = run([{ type: 'player', team: 'us', player: '8' }], { state: r.state });
  assert.equal(adds(r2.ops)[0].player, '8');
});

test('相手のファウルは背番号、分からなければ番号なし', () => {
  const r = run([
    { type: 'team', team: 'opp' },
    { type: 'player', team: 'opp', player: '10' },
    { type: 'play', action: 'foul' },
    { type: 'play', action: 'foul' },
    { type: 'player', team: 'opp', player: null },
  ]);
  assert.deepEqual(adds(r.ops).map((d) => [d.team, d.player]), [['opp', '10'], ['opp', null]]);
});

test('アシスト・スティール・ブロックは自チームのみ', () => {
  const r = run([
    { type: 'team', team: 'opp' },
    { type: 'player', team: 'opp', player: '4' },
    { type: 'play', action: 'ast' },
  ]);
  assert.equal(adds(r.ops).length, 0);
  assert.equal(r.errors.length, 1);
  const r2 = run([
    { type: 'team', team: 'opp' },
    { type: 'play', action: 'stl' },
  ]);
  assert.equal(r2.state.action, null);
  assert.equal(r2.errors.length, 1);
});

test('ターンオーバーの後は種類タグを出す', () => {
  const r = run([
    { type: 'player', team: 'us', player: '4' },
    { type: 'play', action: 'to' },
    { type: 'tag', tag: 'パスミス' },
  ]);
  const [d] = adds(r.ops);
  assert.equal(d.type, 'to');
  assert.equal(r.state.tagKind, 'to');
  assert.deepEqual(r.ops[1], { op: 'patch', id: d.id, patch: { tags: ['パスミス'] } });
});

test('5ファウルの選手は選べない', () => {
  const r = run([{ type: 'player', team: 'us', player: '5' }], { isDisabled: (t, p) => t === 'us' && p === '5' });
  assert.equal(r.state.sel, null);
  assert.equal(r.errors.length, 1);
});

test('タイムアウト → 自／相手', () => {
  const r = run([
    { type: 'sheet', sheet: 'timeout' },
    { type: 'timeout', team: 'opp' },
  ]);
  assert.deepEqual(adds(r.ops).map((d) => [d.type, d.team, d.player]), [['timeout', 'opp', null]]);
  assert.equal(r.state.sheet, null);
});

test('得点補正 → 自／相手 → +1/+2/+3', () => {
  const r = run([
    { type: 'sheet', sheet: 'adjust' },
    { type: 'adjust', team: 'us', points: 2 },
  ]);
  const [d] = adds(r.ops);
  assert.deepEqual([d.type, d.team, d.made, d.points], ['adjust', 'us', true, 2]);
  const bad = run([{ type: 'adjust', team: 'us', points: 5 }]);
  assert.equal(adds(bad.ops).length, 0);
});

test('シュート位置の後に別のプレーを押したらシュートは取りやめ', () => {
  const r = run([
    { type: 'court', x: 12, y: 3 },
    { type: 'play', action: 'to' },
  ]);
  assert.equal(r.state.loc, null);
  assert.equal(r.state.action, 'to');
});

test('チームを切り替えると選手の選択は外れ、シュート位置は残る', () => {
  const r = run([
    { type: 'player', team: 'us', player: '4' },
    { type: 'court', x: 12, y: 3 },
    { type: 'team', team: 'opp' },
  ]);
  assert.equal(r.state.sel, null);
  assert.ok(r.state.loc);
  assert.equal(r.state.sheet, null);
  const r2 = run([{ type: 'player', team: 'opp', player: null }, { type: 'fgResult', made: true }], { state: r.state });
  assert.deepEqual(adds(r2.ops).map((d) => [d.team, d.player, d.zone]), [['opp', null, 'ミドル右']]);
});

test('自チームのシュートは選手なしでは記録しない', () => {
  const r = run([
    { type: 'court', x: 12, y: 3 },
    { type: 'player', team: 'us', player: null },
  ]);
  assert.equal(r.state.sheet, null);
  assert.equal(r.errors.length, 1);
});

test('同じ選手をもう一度押すと選択を外す', () => {
  const r = run([
    { type: 'player', team: 'us', player: '4' },
    { type: 'player', team: 'us', player: '4' },
  ]);
  assert.equal(r.state.sel, null);
});

test('取消で入力途中の状態を消す（チームの表示は残す）', () => {
  const r = run([
    { type: 'team', team: 'opp' },
    { type: 'court', x: 3, y: 3 },
    { type: 'cancel' },
  ]);
  assert.equal(r.state.loc, null);
  assert.equal(r.state.team, 'opp');
});

test('案内文は操作の案内だけ（「すべき」を含まない）', () => {
  const states = [
    initialInput(),
    { ...initialInput(), loc: { x: 1, y: 1 } },
    { ...initialInput(), action: 'dreb' },
    { ...initialInput(), action: 'foul', team: 'opp' },
    { ...initialInput(), sel: { team: 'us', player: '4' } },
  ];
  for (const s of states) {
    const h = hintFor(s);
    assert.ok(h.length > 0);
    assert.ok(!h.includes('すべき'));
    assert.ok(!/TO/.test(h));
  }
});

test('続きの1タップ：自チームのシュート成功の直後にアシスト（もう一度で取り消し、別の選手で付け替え）', () => {
  const base = run([
    { type: 'court', x: 7.5, y: 3 },
    { type: 'player', team: 'us', player: '7' },
    { type: 'fgResult', made: true },
  ]);
  assert.equal(base.state.sheet, 'tags');
  assert.deepEqual(base.state.after, { kind: 'fg', team: 'us', player: '7', made: true });
  let n = 100;
  const ctx = { newId: () => `a${++n}` };
  let r = step(base.state, { type: 'assist', player: '4' }, ctx);
  assert.deepEqual(r.ops, [{ op: 'add', draft: { id: 'a101', team: 'us', player: '4', type: 'ast', tags: [] } }]);
  assert.equal(r.state.sheet, 'tags', '種類タグはそのまま選べる');
  r = step(r.state, { type: 'assist', player: '5' }, ctx);
  assert.deepEqual(r.ops.map((o) => o.op), ['remove', 'add']);
  assert.equal(r.ops[0].id, 'a101');
  r = step(r.state, { type: 'assist', player: '5' }, ctx);
  assert.deepEqual(r.ops, [{ op: 'remove', id: 'a102' }]);
  assert.equal(r.state.assistPlayer, null);
  assert.match(step(base.state, { type: 'assist', player: '7' }, ctx).error, /シュートした選手/);
  // 失敗・相手のシュートでは何もしない
  const miss = run([{ type: 'court', x: 7.5, y: 3 }, { type: 'player', team: 'us', player: '7' }, { type: 'fgResult', made: false }]);
  assert.deepEqual(step(miss.state, { type: 'assist', player: '4' }, ctx).ops, []);
  const opp = run([{ type: 'court', x: 7.5, y: 3 }, { type: 'player', team: 'opp', player: '9' }, { type: 'fgResult', made: true }]);
  assert.deepEqual(step(opp.state, { type: 'assist', player: '4' }, ctx).ops, []);
});

test('続きの1タップ：シュート失敗の直後にリバウンド（同じチームは OR、相手は DR）', () => {
  const miss = run([{ type: 'court', x: 7.5, y: 3 }, { type: 'player', team: 'us', player: '7' }, { type: 'fgResult', made: false }]);
  const ctx = { newId: () => 'r1' };
  let r = step(miss.state, { type: 'rebound', team: 'us', player: '8' }, ctx);
  assert.deepEqual(r.ops, [{ op: 'add', draft: { id: 'r1', team: 'us', player: '8', type: 'oreb', tags: [] } }]);
  assert.equal(r.state.sheet, null, 'リバウンドを記録したら閉じる');
  r = step(miss.state, { type: 'rebound', team: 'opp', player: null }, ctx);
  assert.equal(r.ops[0].draft.type, 'dreb');
  assert.equal(r.ops[0].draft.team, 'opp');
  assert.equal(r.ops[0].draft.player, null);
  const oppMiss = run([{ type: 'court', x: 7.5, y: 3 }, { type: 'player', team: 'opp', player: '9' }, { type: 'fgResult', made: false }]);
  assert.equal(step(oppMiss.state, { type: 'rebound', team: 'us', player: '4' }, ctx).ops[0].draft.type, 'dreb');
  // 5ファウルの選手は選べない
  assert.match(step(miss.state, { type: 'rebound', team: 'us', player: '5' }, { ...ctx, isDisabled: (t, p) => p === '5' }).error, /5ファウル/);
  // 成功のあとはリバウンドなし
  const made = run([{ type: 'court', x: 7.5, y: 3 }, { type: 'player', team: 'us', player: '7' }, { type: 'fgResult', made: true }]);
  assert.deepEqual(step(made.state, { type: 'rebound', team: 'us', player: '8' }, ctx).ops, []);
});

test('続きの1タップ：フリースローの直後に同じ選手の次の1本、外れたらリバウンド', () => {
  const ft = run([{ type: 'player', team: 'us', player: '7' }, { type: 'play', action: 'ft_made' }]);
  assert.equal(ft.state.sheet, 'ft');
  assert.deepEqual(ft.state.after, { kind: 'ft', team: 'us', player: '7', made: true });
  const ctx = { newId: () => 'f2' };
  const r = step(ft.state, { type: 'ftAgain', made: false }, ctx);
  assert.deepEqual(r.ops, [{ op: 'add', draft: { id: 'f2', team: 'us', player: '7', type: 'ft', made: false, points: 1, tags: [] } }]);
  assert.equal(r.state.sheet, 'ft');
  assert.equal(r.state.after.made, false);
  const reb = step(r.state, { type: 'rebound', team: 'opp', player: '4' }, { newId: () => 'r9' });
  assert.equal(reb.ops[0].draft.type, 'dreb');
  // ほかの操作を始めたら閉じる
  const other = step(ft.state, { type: 'player', team: 'opp', player: '4' }, ctx);
  assert.equal(other.state.sheet, null);
  assert.equal(other.state.after, null);
  assert.deepEqual(other.state.sel, { team: 'opp', player: '4' });
});
