import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onCourt, benchOf, swapPlan, playingTime, minutesText, addToRoster, defaultStarters } from '../js/lineup.js';
import { makeEvent, describeEvent, EVENT_TYPES, TYPE_LABEL } from '../js/model.js';
import { teamBox } from '../js/stats.js';

let seq = 0;
const ev = (draft, quarter = 1) => makeEvent(draft, { gameId: 'g', seq: ++seq, quarter, live: { usDF: 'マンツー', oppDF: 'マンツー' }, ts: seq * 1000 });
const roster = ['4', '5', '6', '7', '8', '9', '10'].map((n) => ({ number: n, name: '' }));

test('出場メンバー：記録していなければ null、交代を順に当てはめる', () => {
  seq = 0;
  assert.equal(onCourt([]), null);
  const events = [
    ev({ type: 'lineup', team: 'us', players: ['4', '5', '6', '7', '8'] }),
    ev({ type: 'q_start' }),
    ev({ type: 'sub', team: 'us', player: '9', out: '6' }),
  ];
  assert.deepEqual(onCourt(events), ['4', '5', '9', '7', '8'], '出た選手の位置に入る');
  events.push(ev({ type: 'sub', team: 'us', player: '6', out: '4' }));
  assert.deepEqual(onCourt(events), ['6', '5', '9', '7', '8']);
  // 取り消し（最後の交代を消す）と元に戻る
  assert.deepEqual(onCourt(events.slice(0, -1)), ['4', '5', '9', '7', '8']);
  // コートにいる選手を入れる交代は無視する
  events.push(ev({ type: 'sub', team: 'us', player: '5', out: '7' }));
  assert.deepEqual(onCourt(events), ['6', '5', '9', '7', '8']);
  // 並びが seq 順でなくても同じ
  assert.deepEqual(onCourt([...events].reverse()), ['6', '5', '9', '7', '8']);
  assert.deepEqual(benchOf(roster, onCourt(events)), ['4', '10']);
  assert.deepEqual(benchOf(roster, null), roster.map((p) => p.number));
});

test('出場メンバー：交代の組（出た選手はコートの位置の順、入った選手は選んだ順）', () => {
  assert.deepEqual(swapPlan(['4', '5', '6', '7', '8'], ['4', '10', '6', '9', '8']), [{ out: '5', in: '10' }, { out: '7', in: '9' }]);
  assert.deepEqual(swapPlan(['4', '5', '6', '7', '8'], ['4', '5', '6', '7', '8']), []);
  assert.deepEqual(swapPlan(['4', '5', '6', '7', '8'], ['8', '7', '6', '5', '4']), [], '並びが変わっただけなら交代なし');
});

test('出場時間と +/-：時計の残り秒の差で数え、交代の前後で分ける', () => {
  seq = 0;
  const events = [
    ev({ type: 'lineup', team: 'us', players: ['4', '5', '6', '7', '8'] }),
    ev({ type: 'q_start', clock: 600 }),
    ev({ type: 'fg', team: 'us', player: '4', made: true, points: 2, x: 7.5, y: 2, zone: 'paint', clock: 540 }),
    ev({ type: 'foul', team: 'opp', player: '7', clock: 480 }),
    ev({ type: 'sub', team: 'us', player: '9', out: '6', clock: 480 }),
    ev({ type: 'fg', team: 'opp', player: '7', made: true, points: 3, x: 1, y: 1, zone: 'c3_left', clock: 300 }),
    ev({ type: 'q_end', clock: 0 }),
    // クォーター間の交代：時間は数えない
    ev({ type: 'sub', team: 'us', player: '6', out: '9' }),
    ev({ type: 'q_start', clock: 600 }, 2),
    ev({ type: 'ft', team: 'us', player: '5', made: true, points: 1, clock: 500 }, 2),
    ev({ type: 'q_end', clock: 400 }, 2),
  ];
  const r = playingTime(events);
  assert.equal(r.tracked, true);
  assert.equal(r.hasClock, true);
  // 1Q：4,5,7,8 は 600 秒、6 は 120 秒、9 は 480 秒。2Q：0 秒から 200 秒（600→400）
  assert.equal(r.seconds['4'], 800);
  assert.equal(r.seconds['6'], 120 + 200);
  assert.equal(r.seconds['9'], 480);
  assert.equal(r.seconds['10'], undefined);
  // +/-：+2（6 も在籍）、-3（9 在籍）、+1（2Q、6 在籍）
  assert.equal(r.plusMinus['4'], 2 - 3 + 1);
  assert.equal(r.plusMinus['6'], 2 + 1);
  assert.equal(r.plusMinus['9'], -3);
});

test('出場時間：時計を使っていない試合は seconds が null（+/- は数える）', () => {
  seq = 0;
  const events = [
    ev({ type: 'lineup', team: 'us', players: ['4', '5', '6', '7', '8'] }),
    ev({ type: 'q_start' }),
    ev({ type: 'fg', team: 'us', player: '4', made: true, points: 3, x: 1, y: 1, zone: 'c3_left' }),
  ];
  const r = playingTime(events);
  assert.equal(r.seconds, null);
  assert.equal(r.plusMinus['8'], 3);
  assert.equal(playingTime([ev({ type: 'q_start', clock: 600 })]).tracked, false);
});

test('出場時間：時計を巻き戻した（残りが増えた）ときは、その分を足さない', () => {
  seq = 0;
  const events = [
    ev({ type: 'lineup', team: 'us', players: ['4', '5', '6', '7', '8'] }),
    ev({ type: 'q_start', clock: 600 }),
    ev({ type: 'foul', team: 'us', player: '4', clock: 500 }),
    ev({ type: 'foul', team: 'us', player: '5', clock: 520 }),
    ev({ type: 'q_end', clock: 0 }),
  ];
  assert.equal(playingTime(events).seconds['4'], 100 + 520);
});

test('出場時間の表示、名簿への追加、先発の初期値', () => {
  assert.equal(minutesText(754.4), '12:34');
  assert.equal(minutesText(0), '0:00');
  assert.equal(minutesText(null), '—');
  const r = addToRoster(roster, '15', '  あおい  ');
  assert.equal(r.error, undefined);
  assert.deepEqual(r.roster.at(-1), { number: '15', name: 'あおい' });
  assert.match(addToRoster(roster, '4').error, /もう名簿/);
  assert.match(addToRoster(roster, '123').error, /0〜99/);
  assert.deepEqual(defaultStarters(roster), ['4', '5', '6', '7', '8']);
});

test('交代・出場メンバーのイベント：形、表示、ボックススコアに入れない', () => {
  seq = 0;
  assert.ok(EVENT_TYPES.includes('sub') && EVENT_TYPES.includes('lineup'));
  assert.equal(TYPE_LABEL.sub, '選手交代');
  const s = ev({ type: 'sub', team: 'us', player: 12, out: 5, clock: 321.5 });
  assert.equal(s.player, '12');
  assert.equal(s.out, '5');
  assert.equal(s.clock, 321.5);
  assert.equal(s.defense, null);
  assert.equal(describeEvent(s), '交代 自#5 → #12');
  const l = ev({ type: 'lineup', team: 'us', players: [4, 5, 6, 7, 8] });
  assert.deepEqual(l.players, ['4', '5', '6', '7', '8']);
  assert.equal(l.player, null);
  assert.equal(describeEvent(l), '出場メンバー 自#4・#5・#6・#7・#8');
  const f = ev({ type: 'foul', team: 'us', player: '5' });
  assert.equal(f.clock, null);
  assert.equal('out' in f, false);
  const box = teamBox([s, l], 'us', roster);
  assert.equal(box.other, null);
  assert.equal(box.rows.length, roster.length, '交代で入った #12 を名簿外の行として足さない');
});
