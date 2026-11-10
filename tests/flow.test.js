import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreFlow, scoreAt, quarterAt, teamCompare, pct, playingMinute, buildScoreSheet } from '../js/flow.js';
import { makeEvent } from '../js/model.js';
import { generateDemo } from '../js/demo.js';
import { scoreOf, scoreByQuarter } from '../js/stats.js';

let seq = 0;
const ev = (draft, quarter = 1) => makeEvent(draft, { gameId: 'g', seq: ++seq, quarter, live: { usDF: 'マンツー', oppDF: '2-3ゾーン' }, ts: seq * 1000 });
const fg = (team, player, made, points, clock, q = 1) => ev({ type: 'fg', team, player, made, points, x: 7.5, y: 2, zone: 'ゴール下', clock }, q);

test('試合の流れ：時計の残り秒から経過秒を出し、得点を積み上げる。タイムアウトの位置', () => {
  seq = 0;
  const events = [
    ev({ type: 'q_start', clock: 600 }),
    fg('us', '4', true, 2, 540),
    fg('opp', '7', true, 3, 480),
    fg('us', '5', false, 2, 450),
    ev({ type: 'timeout', team: 'us', clock: 400 }),
    ev({ type: 'ft', team: 'us', player: '4', made: true, points: 1, clock: 400 }),
    ev({ type: 'q_end', clock: 0 }),
    ev({ type: 'q_start', clock: 600 }, 2),
    fg('opp', '9', true, 2, 300, 2),
  ];
  const f = scoreFlow(events);
  assert.equal(f.quarters.length, 4);
  assert.deepEqual(f.quarters.slice(0, 2).map((q) => [q.q, q.start, q.end]), [[1, 0, 600], [2, 600, 1200]]);
  assert.equal(f.total, 2400);
  assert.deepEqual(f.points.map((p) => [p.t, p.team, p.us, p.opp]), [[60, 'us', 2, 0], [120, 'opp', 2, 3], [200, 'us', 3, 3], [900, 'opp', 3, 5]]);
  assert.deepEqual(f.timeouts.map((x) => [x.t, x.team, x.us, x.opp]), [[200, 'us', 2, 3]]);
  assert.equal(f.maxScore, 5);
  assert.deepEqual(scoreAt(f, 130), { us: 2, opp: 3 });
  assert.deepEqual(scoreAt(f, 10), { us: 0, opp: 0 });
  assert.deepEqual(quarterAt(f, 900), { quarter: 2, left: 300 });
});

test('試合の流れ：時計を使っていない記録は、そのクォーターの中に順に並べる。延長は5分', () => {
  seq = 0;
  const events = [fg('us', '4', true, 2, null), fg('us', '4', true, 2, null), fg('opp', '7', true, 2, null, 5)];
  const f = scoreFlow(events);
  assert.deepEqual(f.points.map((p) => Math.round(p.t)), [200, 400, 2550]);
  assert.equal(f.quarters[4].end - f.quarters[4].start, 300);
});

test('両チームの比較：2P・3P・FT、リバウンド（チームリバウンド）、ターンオーバー、ファウル、タイムアウト。クォーターで絞る', () => {
  seq = 0;
  const events = [
    fg('us', '4', true, 2, 500), fg('us', '4', false, 2, 490), fg('us', '7', true, 3, 480), fg('us', '7', false, 3, 470),
    ev({ type: 'ft', team: 'us', player: '4', made: true, points: 1 }), ev({ type: 'ft', team: 'us', player: '4', made: false, points: 1 }),
    ev({ type: 'oreb', team: 'us', player: '5' }), ev({ type: 'dreb', team: 'us', player: null }),
    ev({ type: 'dreb', team: 'opp', player: null }), ev({ type: 'to', team: 'opp', player: '9' }),
    ev({ type: 'foul', team: 'opp', player: '9' }), ev({ type: 'timeout', team: 'opp' }),
    ev({ type: 'stl', team: 'us', player: '5' }), fg('opp', '9', true, 2, 100, 2),
  ];
  const c = teamCompare(events);
  assert.deepEqual([c.us.twoM, c.us.twoA, c.us.threeM, c.us.threeA, c.us.ftM, c.us.ftA, c.us.fgM, c.us.fgA], [1, 2, 1, 2, 1, 2, 2, 4]);
  assert.equal(c.us.pts, 6);
  assert.deepEqual([c.us.oreb, c.us.dreb, c.us.teamReb, c.us.stl], [1, 1, 1, 1]);
  assert.deepEqual([c.opp.dreb, c.opp.teamReb, c.opp.to, c.opp.pf, c.opp.timeouts, c.opp.pts], [1, 1, 1, 1, 1, 2]);
  const q1 = teamCompare(events, 1);
  assert.equal(q1.opp.pts, 0);
  assert.equal(teamCompare(events, 2).opp.twoM, 1);
  assert.equal(pct(1, 3), 33);
  assert.equal(pct(0, 0), null);
});

test('スコアシート：何分目（時計から）、ランニングスコアの印、クォーターの終わり、ファウル、出場', () => {
  assert.equal(playingMinute(600, 600), 1);
  assert.equal(playingMinute(405, 600), 4, '残り 6:45 は4分目');
  assert.equal(playingMinute(0, 600), 10);
  assert.equal(playingMinute(null, 600), null);
  seq = 0;
  const game = { roster: [{ number: '4', name: 'アオイ' }, { number: '5', name: 'ユイ' }, { number: '9', name: 'メイ' }], oppNumbers: ['7'] };
  const events = [
    ev({ type: 'lineup', team: 'us', players: ['4', '5'] }),
    ev({ type: 'q_start', clock: 600 }),
    fg('us', '4', true, 2, 540),
    fg('us', '5', true, 3, 500),
    ev({ type: 'ft', team: 'us', player: '4', made: true, points: 1, clock: 480 }),
    ev({ type: 'foul', team: 'us', player: '5', clock: 470 }),
    ev({ type: 'foul', team: 'opp', player: '12', clock: 460 }),
    ev({ type: 'timeout', team: 'us', clock: 405 }),
    fg('opp', '7', true, 2, 300),
    ev({ type: 'adjust', team: 'opp', points: 1, clock: 200 }),
    ev({ type: 'q_end', clock: 0 }),
    ev({ type: 'sub', team: 'us', player: '9', out: '4' }),
    ev({ type: 'q_start', clock: 600 }, 3),
    ev({ type: 'timeout', team: 'opp' }, 3),
    ev({ type: 'foul', team: 'us', player: '5' }, 3),
  ];
  const s = buildScoreSheet(game, events);
  const us = s.teams.us;
  assert.deepEqual(us.running, {
    2: { kind: 'fg2', player: '4', quarter: 1 },
    5: { kind: 'fg3', player: '5', quarter: 1 },
    6: { kind: 'ft', player: '4', quarter: 1 },
  });
  assert.deepEqual(s.teams.opp.running, { 2: { kind: 'fg2', player: '7', quarter: 1 }, 3: { kind: 'adjust', player: null, quarter: 1 } });
  assert.equal(s.teams.us.quarterEnd[1], 6);
  assert.equal(s.teams.us.quarterEnd[2], 6, '点が入らなかったクォーターも、その時点の得点');
  assert.deepEqual(us.timeouts, { h1: [4], h2: [], ot: [] });
  assert.deepEqual(s.teams.opp.timeouts, { h1: [], h2: [null], ot: [] });
  assert.deepEqual(us.teamFouls, [1, 0, 1, 0]);
  const p = Object.fromEntries(us.players.map((x) => [x.number, x]));
  assert.deepEqual([p['4'].starter, p['4'].played, p['9'].starter, p['9'].played], [true, true, false, true]);
  assert.deepEqual(p['5'].fouls, [1, 3]);
  assert.deepEqual(s.teams.opp.players.map((x) => x.number), ['7', '12'], '記録に出てきた背番号も載せる');
  assert.deepEqual(s.final, { us: 6, opp: 3 });
  assert.equal(s.winner, 'us');
});

test('スコアシート：デモ試合でクォーターの終わりの得点と最終スコアがそろう', () => {
  const { game, events } = generateDemo({ seed: 3 });
  const s = buildScoreSheet(game, events);
  const final = scoreOf(events);
  const byQ = scoreByQuarter(events);
  assert.deepEqual(s.final, final);
  assert.equal(s.teams.us.quarterEnd[4], final.us);
  assert.equal(s.teams.opp.quarterEnd[2], byQ.opp[0] + byQ.opp[1]);
  assert.equal(Math.max(...Object.keys(s.teams.us.running).map(Number)), final.us);
  const flow = scoreFlow(events);
  assert.deepEqual({ us: flow.points.at(-1).us, opp: flow.points.at(-1).opp }, { us: final.us, opp: final.opp });
});
