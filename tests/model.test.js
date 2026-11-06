import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defenseFor, makeEvent, quarterState, quarterLabel, describeEvent, nextSeq, uuid, sortNumbers,
  newGame, sortGames, parseNumberList, defenseSide, TYPE_LABEL, SHOT_TAGS, TO_TAGS, DEFAULT_DEFENSES,
} from '../js/model.js';
import { ZONE_LABELS } from '../js/court.js';
import { ACTIONS } from '../js/input.js';

const live = { usDF: '2-3ゾーン', oppDF: '2-2-1プレス' };

test('自チームの攻撃には相手DF、相手の攻撃には自DFが付く', () => {
  for (const type of ['fg', 'ft', 'oreb', 'to', 'ast']) {
    assert.equal(defenseFor(type, 'us', live), '2-2-1プレス', type);
    assert.equal(defenseFor(type, 'opp', live), '2-3ゾーン', type);
  }
});

test('守備側のプレー（DR・スティール・ブロック・ファウル）には自分たちの隊形が付く', () => {
  for (const type of ['dreb', 'stl', 'blk', 'foul']) {
    assert.equal(defenseFor(type, 'us', live), '2-3ゾーン', type);
    assert.equal(defenseFor(type, 'opp', live), '2-2-1プレス', type);
  }
});

test('タイムアウト・クォーター開始/終了には隊形を付けない', () => {
  for (const type of ['timeout', 'q_start', 'q_end']) assert.equal(defenseFor(type, 'us', live), null);
});

test('makeEvent は SPEC 3-5 の形を作る', () => {
  const e = makeEvent(
    { type: 'fg', team: 'us', player: 7, made: true, points: 2, x: 10.234, y: 3.1, zone: 'ミドル右', tags: ['ドライブ'] },
    { gameId: 'g1', seq: 57, quarter: 2, live, ts: 1762150000000, id: 'e57' },
  );
  assert.deepEqual(e, {
    id: 'e57', gameId: 'g1', seq: 57, quarter: 2, team: 'us', player: '7', type: 'fg', made: true, points: 2,
    x: 10.23, y: 3.1, zone: 'ミドル右', tags: ['ドライブ'], defense: '2-2-1プレス', ts: 1762150000000, clock: null,
  });
  // 試合時計の残り秒（記録画面から渡す）
  assert.equal(makeEvent({ type: 'foul', team: 'us', player: '5' }, { gameId: 'g1', seq: 3, quarter: 2, live, ts: 1, clock: 332.4 }).clock, 332.4);
  const f = makeEvent({ type: 'foul', team: 'opp', player: null }, { gameId: 'g1', seq: 1, quarter: 1, live, ts: 1 });
  assert.equal(f.player, null);
  assert.equal(f.made, null);
  assert.equal(f.x, null);
  assert.equal(f.defense, '2-2-1プレス');
  assert.ok(f.id);
  const a = makeEvent({ type: 'adjust', team: 'us', points: 3 }, { gameId: 'g1', seq: 2, quarter: 1, live, ts: 1 });
  assert.equal(a.made, true);
  assert.equal(a.points, 3);
  assert.equal(a.defense, null);
});

test('クォーターの状態', () => {
  assert.deepEqual(quarterState([]), { phase: 'pre', quarter: 1, next: 1 });
  const ev = [
    { seq: 1, type: 'q_start', quarter: 1 },
    { seq: 2, type: 'fg', quarter: 1 },
  ];
  assert.deepEqual(quarterState(ev), { phase: 'live', quarter: 1, next: 2 });
  ev.push({ seq: 3, type: 'q_end', quarter: 1 });
  assert.deepEqual(quarterState(ev), { phase: 'break', quarter: 1, next: 2 });
  // 並び順に関係なく seq で判断する
  assert.deepEqual(quarterState([...ev].reverse()), { phase: 'break', quarter: 1, next: 2 });
});

test('クォーターの表示', () => {
  assert.equal(quarterLabel(1), '1Q');
  assert.equal(quarterLabel(4), '4Q');
  assert.equal(quarterLabel(5), '延長1');
  assert.equal(quarterLabel(6), '延長2');
});

test('記録ログの文言', () => {
  const base = { quarter: 2, tags: [] };
  assert.equal(describeEvent({ ...base, type: 'fg', team: 'us', player: '7', points: 3, made: true, zone: '3P右45度' }, ZONE_LABELS), '自#7 3P成功 右45度');
  assert.equal(describeEvent({ ...base, type: 'fg', team: 'opp', player: null, points: 2, made: false, zone: 'ゴール下', tags: ['ドライブ'] }, ZONE_LABELS), '相手 2P失敗 ゴール下（ドライブ）');
  assert.equal(describeEvent({ ...base, type: 'ft', team: 'us', player: '4', made: true }), '自#4 FT成功');
  assert.equal(describeEvent({ ...base, type: 'to', team: 'us', player: '4', tags: ['パスミス'] }), '自#4 ターンオーバー（パスミス）');
  assert.equal(describeEvent({ ...base, type: 'dreb', team: 'opp', player: null }), '相手 DR');
  assert.equal(describeEvent({ ...base, type: 'oreb', team: 'us', player: null }), '自チーム OR');
  assert.equal(describeEvent({ ...base, type: 'timeout', team: 'opp' }), 'タイムアウト（相手）');
  assert.equal(describeEvent({ ...base, type: 'adjust', team: 'us', points: 2 }), '得点補正 自チーム +2');
  assert.equal(describeEvent({ ...base, type: 'q_start' }), '2Q 開始');
});

test('画面の文言に「TO」を使わない', () => {
  const labels = [
    ...Object.values(TYPE_LABEL), ...SHOT_TAGS, ...TO_TAGS, ...DEFAULT_DEFENSES,
    ...Object.values(ACTIONS).map((a) => a.label),
  ];
  for (const l of labels) assert.ok(!/TO/.test(l), l);
});

test('seq は最大値＋1', () => {
  assert.equal(nextSeq([]), 1);
  assert.equal(nextSeq([{ seq: 3 }, { seq: 10 }, { seq: 7 }]), 11);
});

test('uuid の形', () => {
  assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('背番号は数値順', () => {
  assert.deepEqual(sortNumbers(['10', '4', '00', '0', '23', '7']), ['0', '00', '4', '7', '10', '23']);
});

test('新しい試合の形と並び順', () => {
  const g = newGame({ date: '2026-11-01', opponent: 'A高', roster: [{ number: 4, name: 'X' }], oppNumbers: [10, 4] });
  assert.equal(g.roster[0].number, '4');
  assert.deepEqual(g.oppNumbers, ['4', '10']);
  assert.deepEqual(g.live, { usDF: 'マンツー', oppDF: 'マンツー' });
  assert.deepEqual(g.videos, []);
  assert.deepEqual(g.insights, []);
  const games = [
    { id: 'a', date: '2026-10-01', createdAt: 1 },
    { id: 'b', date: '2026-11-01', createdAt: 1 },
    { id: 'c', date: '2026-10-01', createdAt: 5 },
  ];
  assert.deepEqual(sortGames(games).map((x) => x.id), ['b', 'c', 'a']);
});

test('相手の背番号の入力（スペース・読点・全角数字）', () => {
  assert.deepEqual(parseNumberList('4 5、７，10  12'), { numbers: ['4', '5', '7', '10', '12'], bad: [] });
  assert.deepEqual(parseNumberList('4 4 00'), { numbers: ['4', '00'], bad: [] });
  assert.deepEqual(parseNumberList('4 abc 123'), { numbers: ['4'], bad: ['abc', '123'] });
  assert.deepEqual(parseNumberList(''), { numbers: [], bad: [] });
});

test('守っているチーム', () => {
  assert.equal(defenseSide('fg', 'us'), 'opp');
  assert.equal(defenseSide('stl', 'us'), 'us');
  assert.equal(defenseSide('timeout', 'us'), null);
  assert.equal(defenseSide('fg', null), null);
});
