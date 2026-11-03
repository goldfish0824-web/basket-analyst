import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreOf, scoreByQuarter, teamFouls, playerFouls, teamBox, teamIndicators, byDefense,
  filterShots, zoneStats, shotTotals, pctText, maText, inQuarterRange, pointsScored, taggedPoints,
} from '../js/stats.js';
import { makeEvent } from '../js/model.js';

// テスト用にイベントを手早く作る
function builder() {
  let seq = 0;
  const live = { usDF: 'マンツー', oppDF: 'マンツー' };
  let quarter = 1;
  const events = [];
  const api = {
    events,
    live,
    q(n) { quarter = n; return api; },
    add(draft) {
      seq += 1;
      events.push(makeEvent(draft, { gameId: 'g', seq, quarter, live: { ...live }, ts: seq * 1000, id: `e${seq}` }));
      return api;
    },
    fg(team, player, made, points = 2, zone = points === 3 ? '3Pトップ' : 'ゴール下', tags = []) {
      return api.add({ type: 'fg', team, player, made, points, x: 7.5, y: points === 3 ? 9 : 3, zone, tags });
    },
    ft(team, player, made) { return api.add({ type: 'ft', team, player, made, points: 1 }); },
    simple(type, team, player = null) { return api.add({ type, team, player }); },
  };
  return api;
}

test('得点は成功したFG・FTと得点補正だけ', () => {
  const b = builder()
    .fg('us', '4', true, 2)
    .fg('us', '4', false, 3)
    .fg('us', '7', true, 3)
    .ft('us', '7', true)
    .ft('us', '7', false)
    .add({ type: 'adjust', team: 'us', player: null, made: true, points: 2 })
    .fg('opp', '9', true, 2)
    .simple('foul', 'us', '4');
  assert.deepEqual(scoreOf(b.events), { us: 8, opp: 2 });
  assert.equal(pointsScored(b.events[1]), 0);
});

test('クォーター別得点（延長は5列目以降）', () => {
  const b = builder()
    .q(1).fg('us', '4', true, 2)
    .q(2).fg('opp', '5', true, 3)
    .q(4).ft('us', '4', true)
    .q(5).fg('us', '7', true, 2);
  const s = scoreByQuarter(b.events);
  assert.deepEqual(s.quarters, [1, 2, 3, 4, 5]);
  assert.deepEqual(s.us, [2, 0, 0, 1, 2]);
  assert.deepEqual(s.opp, [0, 3, 0, 0, 0]);
  // 延長がなければ4列
  assert.equal(scoreByQuarter([]).quarters.length, 4);
});

test('チームファウルはそのクォーター分。延長は4Qから続けて数える', () => {
  const b = builder()
    .q(1).simple('foul', 'us', '4').simple('foul', 'us', '5').simple('foul', 'opp', '9')
    .q(2).simple('foul', 'us', '4')
    .q(4).simple('foul', 'opp', '9').simple('foul', 'opp', '10')
    .q(5).simple('foul', 'opp', null);
  assert.deepEqual(teamFouls(b.events, 1), { us: 2, opp: 1 });
  assert.deepEqual(teamFouls(b.events, 2), { us: 1, opp: 0 });
  assert.deepEqual(teamFouls(b.events, 4), { us: 0, opp: 2 });
  assert.deepEqual(teamFouls(b.events, 5), { us: 0, opp: 3 });
});

test('個人ファウルは試合全体で数える（番号なしは数えない）', () => {
  const b = builder()
    .q(1).simple('foul', 'us', '4')
    .q(3).simple('foul', 'us', '4').simple('foul', 'opp', '12').simple('foul', 'opp', null);
  assert.deepEqual(playerFouls(b.events), { us: { 4: 2 }, opp: { 12: 1 } });
});

test('ボックススコア：選手ごと・番号なし・合計', () => {
  const b = builder()
    .fg('us', '4', true, 2)
    .fg('us', '4', false, 3)
    .fg('us', '4', true, 3)
    .ft('us', '4', true)
    .ft('us', '4', false)
    .simple('oreb', 'us', '4')
    .simple('dreb', 'us', '7')
    .simple('dreb', 'us', null) // チームリバウンド
    .simple('ast', 'us', '7')
    .simple('stl', 'us', '7')
    .simple('blk', 'us', '7')
    .simple('to', 'us', '7')
    .simple('to', 'us', null)
    .simple('foul', 'us', '7')
    .fg('us', '15', true, 2) // 名簿にない背番号
    .add({ type: 'adjust', team: 'us', player: null, made: true, points: 1 })
    .simple('timeout', 'us')
    .fg('opp', '9', true, 2);
  const box = teamBox(b.events, 'us', [{ number: '4', name: 'A' }, { number: '7', name: 'B' }, { number: '8', name: 'C' }]);
  assert.deepEqual(box.rows.map((r) => r.number), ['4', '7', '8', '15']);
  const r4 = box.rows[0];
  assert.equal(r4.name, 'A');
  assert.deepEqual(
    [r4.pts, r4.fgm, r4.fga, r4.tpm, r4.tpa, r4.ftm, r4.fta, r4.oreb],
    [6, 2, 3, 1, 2, 1, 2, 1],
  );
  const r7 = box.rows[1];
  assert.deepEqual([r7.dreb, r7.ast, r7.stl, r7.blk, r7.to, r7.pf], [1, 1, 1, 1, 1, 1]);
  assert.equal(box.rows[2].pts, 0);
  assert.equal(box.rows[3].pts, 2);
  assert.deepEqual([box.other.dreb, box.other.to, box.other.pts], [1, 1, 1]);
  assert.equal(box.total.pts, 9);
  assert.equal(box.total.fga, 4);
  assert.equal(box.total.dreb, 2);
  assert.equal(box.total.to, 2);
  // 合計 = 各行 + 番号なし
  for (const k of Object.keys(box.total)) {
    const sum = box.rows.reduce((s, r) => s + r[k], 0) + box.other[k];
    assert.equal(sum, box.total[k], k);
  }
});

test('選手不明のイベントがなければ other は null', () => {
  const b = builder().fg('opp', '9', true);
  assert.equal(teamBox(b.events, 'opp', []).other, null);
});

test('チーム指標：ポゼッション推定・1ポゼッションあたり得点・OR率・セカンドチャンス・速攻', () => {
  const b = builder()
    // 自：FGA 4、FTA 2、OR 1、ターンオーバー 1
    .fg('us', '4', true, 2, 'ゴール下', ['速攻'])
    .fg('us', '4', false, 3)
    .simple('oreb', 'us', '5')
    .fg('us', '5', true, 2, 'ゴール下', ['セカンドチャンス', 'ポスト'])
    .fg('us', '7', true, 3, '3Pトップ', ['速攻'])
    .ft('us', '7', true)
    .ft('us', '7', true)
    .simple('to', 'us', '7')
    // 相手：FGA 2、DR 3、OR 0
    .fg('opp', '9', false)
    .fg('opp', '9', true)
    .simple('dreb', 'opp', '9')
    .simple('dreb', 'opp', null)
    .simple('dreb', 'opp', '4')
    .simple('dreb', 'us', '4');
  const t = teamIndicators(b.events);
  assert.ok(Math.abs(t.us.poss - (4 + 0.44 * 2 - 1 + 1)) < 1e-9);
  assert.equal(t.us.pts, 9);
  assert.ok(Math.abs(t.us.ppp - 9 / 4.88) < 1e-9);
  assert.equal(t.us.orPct, 1 / (1 + 3));
  assert.equal(t.us.secondChancePts, 2);
  assert.equal(t.us.fastBreakPts, 5);
  assert.equal(t.opp.poss, 2);
  assert.equal(t.opp.orPct, 0);
  assert.equal(taggedPoints(b.events, 'opp', '速攻'), 0);
});

test('ポゼッションが0なら1ポゼッションあたり得点は出さない', () => {
  const t = teamIndicators([]);
  assert.equal(t.us.ppp, null);
  assert.equal(t.us.orPct, null);
});

test('守備隊形別：攻撃側のFG・3P・ターンオーバー・得点を、守っている隊形ごとに', () => {
  const b = builder();
  b.fg('us', '4', false, 3).fg('us', '4', true, 2);
  b.live.oppDF = '2-3ゾーン';
  b.fg('us', '7', false, 3).fg('us', '7', false, 3).fg('us', '7', true, 3).simple('to', 'us', '7').ft('us', '7', true);
  b.live.oppDF = '2-2-1プレス';
  b.simple('to', 'us', '4').simple('to', 'us', '5');
  b.fg('opp', '9', true, 2); // 相手の攻撃は自チームの隊形（マンツー）
  b.add({ type: 'adjust', team: 'us', player: null, made: true, points: 2 }); // 補正は隊形別に入れない
  const rows = byDefense(b.events, 'us', ['マンツー', '2-3ゾーン', '3-2ゾーン', '2-2-1プレス']);
  assert.deepEqual(rows.map((r) => r.defense), ['マンツー', '2-3ゾーン', '2-2-1プレス']);
  const [man, zone, press] = rows;
  assert.deepEqual([man.fgm, man.fga, man.tpm, man.tpa, man.to, man.pts], [1, 2, 0, 1, 0, 2]);
  assert.deepEqual([zone.fgm, zone.fga, zone.tpm, zone.tpa, zone.to, zone.pts], [1, 3, 1, 3, 1, 4]);
  assert.deepEqual([press.fga, press.to, press.pts], [0, 2, 0]);
  const oppRows = byDefense(b.events, 'opp', ['マンツー']);
  assert.deepEqual(oppRows.map((r) => [r.defense, r.pts]), [['マンツー', 2]]);
});

test('隊形が付いていないイベントは「未設定」として最後に並ぶ', () => {
  const events = [
    { type: 'fg', team: 'us', made: true, points: 2, defense: null, quarter: 1 },
    { type: 'fg', team: 'us', made: false, points: 2, defense: '独自の隊形', quarter: 1 },
    { type: 'fg', team: 'us', made: false, points: 2, defense: 'マンツー', quarter: 1 },
  ];
  assert.deepEqual(byDefense(events, 'us', ['マンツー']).map((r) => r.defense), ['マンツー', '独自の隊形', '未設定']);
});

test('シュートチャートの絞り込み（チーム・選手・クォーター・隊形・タグ）', () => {
  const b = builder();
  b.q(1).fg('us', '4', true, 2, 'ゴール下', ['ドライブ']).fg('us', '7', false, 3, '3Pトップ');
  b.live.oppDF = '2-3ゾーン';
  b.q(2).fg('us', '4', false, 3, '3P右45度').fg('opp', null, true, 2).simple('foul', 'us', '4');
  b.q(3).fg('us', '7', true, 2, 'ミドル右', ['ジャンプシュート']);
  b.q(5).fg('us', '4', true, 2, 'ゴール下');
  const ev = b.events;
  assert.equal(filterShots(ev, { team: 'us' }).length, 5);
  assert.equal(filterShots(ev, { team: 'opp' }).length, 1);
  assert.equal(filterShots(ev, { team: 'opp', player: 'none' }).length, 1);
  assert.equal(filterShots(ev, { team: 'us', player: '4' }).length, 3);
  assert.equal(filterShots(ev, { team: 'us', quarter: 2 }).length, 1);
  assert.equal(filterShots(ev, { team: 'us', quarter: '1' }).length, 2);
  assert.equal(filterShots(ev, { team: 'us', quarter: 'H1' }).length, 3);
  assert.equal(filterShots(ev, { team: 'us', quarter: 'H2' }).length, 1);
  assert.equal(filterShots(ev, { team: 'us', quarter: 'OT' }).length, 1);
  assert.equal(filterShots(ev, { team: 'us', defense: '2-3ゾーン' }).length, 3);
  assert.equal(filterShots(ev, { team: 'us', defense: 'マンツー' }).length, 2);
  assert.equal(filterShots(ev, { team: 'us', tag: 'ドライブ' }).length, 1);
  assert.equal(filterShots(ev, { team: 'us', tag: 'none' }).length, 3);
});

test('ゾーン別の成功-試投と合計', () => {
  const shots = [
    { type: 'fg', zone: '3P右45度', made: true, points: 3 },
    { type: 'fg', zone: '3P右45度', made: false, points: 3 },
    { type: 'fg', zone: 'ゴール下', made: true, points: 2 },
  ];
  const z = zoneStats(shots);
  assert.deepEqual(z['3P右45度'], { made: 1, att: 2 });
  assert.deepEqual(z['ゴール下'], { made: 1, att: 1 });
  assert.deepEqual(z['ミドル左'], { made: 0, att: 0 });
  assert.equal(Object.keys(z).length, 9);
  assert.deepEqual(shotTotals(shots), { fgm: 2, fga: 3, tpm: 1, tpa: 2, pts: 5 });
});

test('表示の書式', () => {
  assert.equal(pctText(1, 3), '33%');
  assert.equal(pctText(0, 0), '—');
  assert.equal(maText(3, 8), '3-8（38%）');
  assert.equal(maText(0, 0), '0-0');
  assert.ok(inQuarterRange(2, 'all'));
  assert.ok(!inQuarterRange(3, 'H1'));
  assert.ok(inQuarterRange(6, 'OT'));
});
