import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scopesFor, buildCandidates, localScore, rankCandidates, pickLocal, buildPayload, acceptAiResponse,
  localLine, evidenceText, isFoulTrouble, zoneSituation, sideOf, toWire, MAX_AI_CANDIDATES,
} from '../js/insights.js';
import { makeEvent } from '../js/model.js';
import { generateDemo } from '../js/demo.js';

function builder() {
  let seq = 0;
  let quarter = 1;
  const live = { usDF: 'マンツー', oppDF: 'マンツー' };
  const events = [];
  const api = {
    events,
    live,
    q(n) { quarter = n; return api; },
    add(d) {
      seq += 1;
      events.push(makeEvent(d, { gameId: 'g', seq, quarter, live: { ...live }, ts: seq, id: `e${seq}` }));
      return api;
    },
    fg(team, player, made, { points = 2, zone = points === 3 ? '3Pトップ' : 'ゴール下', x = 7.5, tags = [] } = {}) {
      return api.add({ type: 'fg', team, player, made, points, x, y: 3, zone, tags });
    },
    times(n, fn) { for (let i = 0; i < n; i++) fn(i); return api; },
  };
  return api;
}

const find = (cands, category, pred = () => true) => cands.filter((c) => c.category === category && pred(c));

test('範囲：そのクォーター／前半・後半／累計（同じ組み合わせは1つ）', () => {
  assert.deepEqual(scopesFor(1).map((s) => s.label), ['1Q']);
  assert.deepEqual(scopesFor(2).map((s) => s.label), ['2Q', '前半']);
  assert.deepEqual(scopesFor(3).map((s) => s.label), ['3Q', '累計']);
  assert.deepEqual(scopesFor(4).map((s) => s.label), ['4Q', '後半', '累計']);
  assert.deepEqual(scopesFor(5).map((s) => s.label), ['延長1', '累計']);
  assert.deepEqual(scopesFor(5)[1].quarters, [1, 2, 3, 4, 5]);
});

test('相手の得点源の偏り：同じ選手×ゾーン／タグで試投3以上・成功率5割以上', () => {
  const b = builder();
  b.fg('opp', '7', true, { zone: 'ミドル右', x: 11, tags: ['ドライブ'] })
    .fg('opp', '7', true, { zone: 'ミドル右', x: 11.5, tags: ['ドライブ'] })
    .fg('opp', '7', false, { zone: 'ミドル右', x: 12, tags: ['ドライブ'] })
    .fg('opp', '7', true, { zone: 'ミドル右', x: 10.5, tags: ['ドライブ'] })
    .fg('opp', '7', true, { zone: 'ミドル左', x: 3, tags: ['ドライブ'] })
    .fg('opp', '9', false).fg('opp', '9', false).fg('opp', '9', true); // 1/3 は得点源ではない
  const c = buildCandidates(b.events, { quarter: 1 });
  const hot = find(c, 'opp_hot');
  // 同じ4本は「右ドライブ」（左右＋タグ）として1つにまとまる。ドライブ全体は5本で別の集まり
  assert.deepEqual(hot.map((h) => [h.subject, h.situation, h.made, h.att]).sort(), [
    ['相手#7', 'ドライブ', 4, 5],
    ['相手#7', '右ドライブ', 3, 4],
  ]);
  assert.ok(!hot.some((h) => h.subject === '相手#9'));
});

test('相手の得点リーダー：相手得点の30%以上（6点以上）', () => {
  const b = builder();
  b.times(4, () => b.fg('opp', '4', true)).fg('opp', '5', true).fg('opp', '6', true, { points: 3, zone: '3Pトップ' });
  const c = find(buildCandidates(b.events, { quarter: 1 }), 'opp_leader');
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].subject, c[0].value, c[0].total], ['相手#4', 8, 13]);
  assert.equal(localLine(c[0]), '相手#4、1Q8点（相手の62%）');
});

test('自チームの攻めの効率（守備隊形別）：試投5以上で25%以下か60%以上', () => {
  const b = builder();
  b.live.oppDF = '2-3ゾーン';
  b.times(8, (i) => b.fg('us', '4', i === 0, { points: 3 }));
  b.live.oppDF = 'マンツー';
  b.times(5, (i) => b.fg('us', '5', i < 2)); // 40% は出さない
  const c = find(buildCandidates(b.events, { quarter: 2 }), 'us_defense_eff');
  const zone3 = c.find((x) => x.situation === '対2-3ゾーンの3P');
  assert.ok(zone3);
  assert.deepEqual([zone3.made, zone3.att], [1, 8]);
  assert.equal(localLine(zone3), '自チーム、対2-3ゾーンの3Pは8本中1本');
  assert.ok(!c.some((x) => x.situation.startsWith('対マンツー')));
});

test('自チームのゾーン別効率：試投4以上', () => {
  const b = builder();
  b.times(4, (i) => b.fg('us', '7', i < 3, { points: 3, zone: '3P右コーナー', x: 14.5 }));
  b.times(3, () => b.fg('us', '8', true, { zone: 'ミドル左', x: 3 }));
  const c = find(buildCandidates(b.events, { quarter: 1 }), 'us_zone');
  assert.deepEqual(c.map((x) => [x.situation, x.made, x.att]), [['右コーナー3P', 3, 4]]);
});

test('ターンオーバーの集中：クォーター4以上、隊形への偏り', () => {
  const b = builder().q(1);
  b.add({ type: 'to', team: 'us', player: '4' });
  b.q(2);
  b.live.oppDF = '2-2-1プレス';
  b.times(4, () => b.add({ type: 'to', team: 'us', player: '5', tags: ['パスミス'] }));
  b.live.oppDF = 'マンツー';
  b.add({ type: 'to', team: 'us', player: '6' }).add({ type: 'to', team: 'us', player: '6' });
  const c = find(buildCandidates(b.events, { quarter: 2 }), 'turnovers');
  const total = c.find((x) => x.scope === '2Q' && x.value === 6);
  assert.ok(total);
  const press = c.find((x) => x.scope === '2Q' && x.detail === '2-2-1プレスから');
  assert.deepEqual([press.made, press.att], [4, 6]);
  assert.equal(localLine(press), '自チーム、2Qのターンオーバー6本中4本が2-2-1プレスから');
  assert.ok(c.some((x) => x.detail === 'パスミス'));
});

test('リバウンド差：ORの差が4以上', () => {
  const b = builder();
  b.add({ type: 'oreb', team: 'us', player: '4' });
  b.times(5, () => b.add({ type: 'oreb', team: 'opp', player: null }));
  const c = find(buildCandidates(b.events, { quarter: 1 }), 'rebounds');
  assert.deepEqual([c[0].us, c[0].opp], [1, 5]);
  const b2 = builder();
  b2.times(3, () => b2.add({ type: 'oreb', team: 'opp', player: null }));
  assert.equal(find(buildCandidates(b2.events, { quarter: 1 }), 'rebounds').length, 0);
});

test('ファウルトラブル：前半2以上、3Q終了時3以上、4以上はいつでも', () => {
  assert.ok(isFoulTrouble(2, 1));
  assert.ok(isFoulTrouble(2, 2));
  assert.ok(!isFoulTrouble(2, 3));
  assert.ok(isFoulTrouble(3, 3));
  assert.ok(!isFoulTrouble(3, 4));
  assert.ok(isFoulTrouble(4, 4));
  assert.ok(isFoulTrouble(4, 5));
  const b = builder().q(1);
  b.add({ type: 'foul', team: 'us', player: '5' }).add({ type: 'foul', team: 'us', player: '5' });
  b.add({ type: 'foul', team: 'opp', player: '10' });
  b.add({ type: 'foul', team: 'opp', player: null }).add({ type: 'foul', team: 'opp', player: null });
  const c = buildCandidates(b.events, { quarter: 1 });
  const us = find(c, 'foul_trouble');
  assert.deepEqual(us.map((x) => [x.subject, x.value, x.scope]), [['自#5', 2, '1Q終了時']]);
  assert.equal(find(c, 'opp_foul_trouble').length, 0);
  const mid = buildCandidates(b.events, { quarter: 1, inProgress: true });
  assert.equal(find(mid, 'foul_trouble')[0].scope, '1Q途中');
});

test('フリースロー：試投6以上で50%以下', () => {
  const b = builder();
  b.times(7, (i) => b.add({ type: 'ft', team: 'us', player: '4', made: i < 3, points: 1 }));
  const c = find(buildCandidates(b.events, { quarter: 1 }), 'free_throws');
  assert.deepEqual([c[0].made, c[0].att, c[0].subject], [3, 7, '自チーム']);
});

test('流れ：クォーター得点差8以上（そのクォーターの範囲だけ）', () => {
  const b = builder().q(1);
  b.times(4, () => b.fg('opp', '4', true));
  b.q(2);
  b.times(5, () => b.fg('opp', '5', true)).fg('us', '4', true);
  const c = find(buildCandidates(b.events, { quarter: 2 }), 'run');
  assert.deepEqual(c.map((x) => [x.scope, x.us, x.opp]), [['2Q', 2, 10]]);
  assert.equal(localLine(c[0]), '2Q、自チーム2・相手10');
});

test('そのクォーターより後の記録は使わない（あとから見直すとき）', () => {
  const b = builder().q(1);
  b.add({ type: 'foul', team: 'us', player: '5' }).add({ type: 'foul', team: 'us', player: '5' });
  b.q(2).add({ type: 'foul', team: 'us', player: '5' }).add({ type: 'foul', team: 'us', player: '5' });
  const c = buildCandidates(b.events, { quarter: 1 });
  assert.equal(find(c, 'foul_trouble')[0].value, 2);
});

test('範囲が違っても数字が同じなら狭い範囲だけ残す', () => {
  const b = builder().q(1);
  b.q(3).times(5, (i) => b.fg('opp', '7', i < 4, { zone: 'ミドル右', x: 11 }));
  const c = find(buildCandidates(b.events, { quarter: 3 }), 'opp_hot');
  assert.deepEqual(c.map((x) => x.scope), ['3Q']);
});

test('順位付け：ファウル4以上 ＞ 相手の偏り(4本以上7割以上) ＞ 自チームの不振 ＞ ターンオーバー ＞ リバウンド ＞ その他', () => {
  const foul4 = { category: 'foul_trouble', value: 4 };
  const hot = { category: 'opp_hot', made: 4, att: 5 };
  const slump = { category: 'us_defense_eff', team: 'us', made: 1, att: 8 };
  const to = { category: 'turnovers', value: 6 };
  const reb = { category: 'rebounds', us: 2, opp: 8 };
  const other = { category: 'run', us: 9, opp: 19 };
  const foul2 = { category: 'foul_trouble', value: 2 };
  const scores = [foul4, hot, slump, to, reb].map(localScore);
  for (let i = 0; i < scores.length - 1; i++) assert.ok(scores[i] > scores[i + 1], `${i}: ${scores}`);
  // 「その他」はどれもリバウンド差より下
  for (const c of [other, foul2]) assert.ok(localScore(c) < localScore(reb));
  for (const s of [...scores, localScore(other), localScore(foul2)]) assert.ok(s >= 0 && s <= 1);
});

test('同じ段では試投数が多いほど上', () => {
  const a = localScore({ category: 'opp_hot', made: 4, att: 5 });
  const b = localScore({ category: 'opp_hot', made: 7, att: 9 });
  assert.ok(b > a);
  const c = localScore({ category: 'us_zone', team: 'us', made: 1, att: 6 });
  const d = localScore({ category: 'us_zone', team: 'us', made: 2, att: 12 });
  assert.ok(d > c);
});

test('rankCandidates は元の配列を変えない', () => {
  const list = [{ localScore: 0.1 }, { localScore: 0.9 }];
  const r = rankCandidates(list);
  assert.equal(r[0].localScore, 0.9);
  assert.equal(list[0].localScore, 0.1);
});

test('端末内の上位3件は同じカテゴリ×主語を重ねない', () => {
  const cands = [
    { id: 'c1', category: 'opp_hot', subject: '相手#7', localScore: 0.9, att: 5 },
    { id: 'c2', category: 'opp_hot', subject: '相手#7', localScore: 0.85, att: 4 },
    { id: 'c3', category: 'turnovers', subject: '自チーム', localScore: 0.6 },
    { id: 'c4', category: 'opp_hot', subject: '相手#4', localScore: 0.5, att: 3 },
  ];
  assert.deepEqual(pickLocal(cands).map((c) => c.id), ['c1', 'c3', 'c4']);
});

test('デモ試合：ハーフタイムの上位に相手#7のドライブと対2-3ゾーンの3P', () => {
  const { events } = generateDemo({ seed: 1 });
  const c = buildCandidates(events, { quarter: 2 });
  assert.ok(c.length > 0);
  assert.deepEqual(c.map((x) => x.id).slice(0, 3), ['c1', 'c2', 'c3']);
  const lines = pickLocal(c).map(localLine);
  assert.ok(lines.includes('相手#7、ドライブで5本中4本成功'), lines.join(' / '));
  assert.ok(lines.includes('自チーム、対2-3ゾーンの3Pは8本中1本'), lines.join(' / '));
  // 3Q終了時はファウル4の2人が先頭
  const q3 = pickLocal(buildCandidates(events, { quarter: 3 })).map(localLine);
  assert.deepEqual(q3.slice(0, 2), ['自#5、ファウル4（3Q終了時）', '相手#10、ファウル4（3Q終了時）']);
});

test('AI に送る形（SPEC 5-5）：最大20件、名前なし、点数順', () => {
  const { game, events } = generateDemo({ seed: 1 });
  const cands = buildCandidates(events, { quarter: 4 });
  const p = buildPayload({ events, quarter: 2, candidates: cands });
  assert.equal(p.kind, 'quarter_insight');
  assert.equal(p.quarterEnded, 2);
  assert.equal(p.isHalftime, true);
  assert.deepEqual(p.score.byQuarter.us, [11, 7]);
  assert.deepEqual(p.score.byQuarter.opp, [11, 16]);
  assert.deepEqual([p.score.us, p.score.opp], [18, 27]);
  assert.ok(p.candidates.length <= MAX_AI_CANDIDATES);
  for (let i = 1; i < p.candidates.length; i++) assert.ok(p.candidates[i - 1].localScore >= p.candidates[i].localScore);
  const text = JSON.stringify(p);
  for (const { name } of game.roster) assert.ok(!text.includes(name), `名前 ${name} が入っている`);
  assert.ok(!('team' in p.candidates[0]) && !('player' in p.candidates[0]));
  const mid = buildPayload({ events, quarter: 3, inProgress: true, candidates: [] });
  assert.equal(mid.isHalftime, false);
  assert.equal(mid.inProgress, true);
});

test('toWire は決まった項目だけ', () => {
  assert.deepEqual(toWire({ id: 'c1', category: 'x', subject: 's', made: 1, att: 2, team: 'us', player: '5', detail: 'd' }),
    { id: 'c1', category: 'x', subject: 's', made: 1, att: 2 });
});

test('AI の応答：候補にない ID・重複・空行は捨て、最大3つ', () => {
  const cands = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }];
  const r = acceptAiResponse({
    insights: [
      { candidateId: 'c9', line: '作った数字' },
      { candidateId: 'c2', line: ' 相手#7、右ドライブで5本中4本成功 ' },
      { candidateId: 'c2', line: '重複' },
      { candidateId: 'c3', line: '' },
      { candidateId: 'c1', line: '一行' },
      { candidateId: 'c4', line: '二行' },
      { candidateId: 'c3', line: '四つめ' },
    ],
  }, cands);
  assert.deepEqual(r.map((x) => [x.candidateId, x.line]), [['c2', '相手#7、右ドライブで5本中4本成功'], ['c1', '一行'], ['c4', '二行']]);
  assert.equal(r[0].candidate, cands[1]);
  assert.deepEqual(acceptAiResponse(null, cands), []);
  assert.deepEqual(acceptAiResponse({ insights: 'x' }, cands), []);
});

test('文言は事実だけ（「すべき」なし、「TO」なし）', () => {
  const { game, events } = generateDemo({ seed: 1 });
  const names = Object.fromEntries(game.roster.map((p) => [p.number, p.name]));
  for (const q of [1, 2, 3, 4]) {
    for (const c of buildCandidates(events, { quarter: q })) {
      for (const t of [localLine(c), evidenceText(c, names)]) {
        assert.ok(!/すべき|した方が|しましょう/.test(t), t);
        assert.ok(!/TO/.test(t), t);
      }
    }
  }
});

test('根拠の表示：成功-試投と範囲、自チームは呼び名を添える', () => {
  assert.equal(evidenceText({ category: 'opp_hot', made: 4, att: 5, scope: '前半' }), '4-5（80%）　前半');
  assert.equal(
    evidenceText({ category: 'foul_trouble', team: 'us', player: '5', value: 3, scope: '2Q終了時' }, { 5: 'ユイ' }),
    '個人ファウル 3　2Q終了時　#5 ユイ',
  );
});

test('ゾーンと左右の呼び方', () => {
  assert.equal(zoneSituation('3P右45度'), '右45度3P');
  assert.equal(zoneSituation('ミドル右'), 'ミドル右');
  assert.equal(sideOf(3), '左');
  assert.equal(sideOf(7.5), '正面');
  assert.equal(sideOf(12), '右');
});
