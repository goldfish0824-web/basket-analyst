import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentDefenses, cleanQuestion, buildAdvicePayload, acceptAdvice, relatedQaFor, mergeRelated, MAX_QUESTION,
} from '../js/advice.js';
import { buildCandidates, localLine, evidenceText } from '../js/insights.js';
import { makeEvent } from '../js/model.js';
import { generateDemo } from '../js/demo.js';
import { QA_ITEMS } from '../js/qa.js';

const QA_IDS = QA_ITEMS.map((i) => i.id);

function ev(d, seq, quarter, live) {
  return makeEvent(d, { gameId: 'g', seq, quarter, live, ts: seq, id: `e${seq}` });
}

test('直近の守備隊形：相手の守り（自チームの攻めに付く）と自チームの守り', () => {
  const events = [
    ev({ type: 'fg', team: 'us', player: '4', made: true, points: 2, x: 7, y: 3, zone: 'ゴール下' }, 1, 1, { usDF: 'マンツー', oppDF: '2-3ゾーン' }),
    ev({ type: 'fg', team: 'opp', player: '7', made: false, points: 2, x: 7, y: 3, zone: 'ゴール下' }, 2, 1, { usDF: '2-3ゾーン', oppDF: '2-3ゾーン' }),
    ev({ type: 'to', team: 'us', player: '4' }, 3, 1, { usDF: '2-3ゾーン', oppDF: '2-2-1プレス' }),
  ];
  assert.deepEqual(currentDefenses(events), { opp: '2-2-1プレス', us: '2-3ゾーン' });
  assert.deepEqual(currentDefenses([]), { opp: null, us: null });
});

test('質問は空白を詰めて200字まで', () => {
  assert.equal(cleanQuestion('  相手#4を\n止めるには？ '), '相手#4を 止めるには？');
  assert.equal(cleanQuestion('あ'.repeat(300)).length, MAX_QUESTION);
  assert.equal(cleanQuestion(null), '');
});

test('送る形：点数・隊形・特筆データの数字（名前は送らない）・Q&A の一覧', () => {
  const { game, events } = generateDemo({ seed: 7 });
  const cands = buildCandidates(events, { quarter: 2 });
  const item = { candidateId: cands[0].id, line: localLine(cands[0]), candidate: cands[0] };
  const qa = QA_ITEMS.map((i) => ({ id: i.id, title: i.title }));
  const p = buildAdvicePayload({ events, quarter: 2, item, question: ' どうする？ ', qa });
  assert.equal(p.kind, 'advice');
  assert.equal(p.quarter, 2);
  assert.equal(p.isHalftime, true);
  assert.equal(p.question, 'どうする？');
  assert.equal(p.insight.line, item.line);
  assert.equal(p.insight.candidate.id, cands[0].id);
  assert.equal(p.qa.length, QA_ITEMS.length);
  assert.ok(p.score.byQuarter.us.length === 2);
  // 名簿の呼び名は送らない
  const text = JSON.stringify(p);
  for (const r of game.roster) if (r.name) assert.ok(!text.includes(r.name), r.name);
  // 質問だけでもよい（特筆データなし）
  const onlyQ = buildAdvicePayload({ events, quarter: 3, inProgress: true, question: '相手のプレスは？' });
  assert.equal(onlyQ.insight, undefined);
  assert.equal(onlyQ.isHalftime, false);
  assert.equal(onlyQ.inProgress, true);
});

test('応答：見出しと説明のそろった例を最大3つ、関連は Q&A にある ID だけ（重複なし）', () => {
  const r = acceptAdvice({
    options: [
      { label: ' A ', detail: ' 説明A ' },
      { label: '', detail: '見出しなし' },
      { label: 'B', detail: '説明B' },
      { label: 'C', detail: '説明C' },
      { label: 'D', detail: '説明D' },
    ],
    related: ['zone-23', 'nope', 'zone-23', 'press-221'],
  }, QA_IDS);
  assert.deepEqual(r.options.map((o) => o.label), ['A', 'B', 'C']);
  assert.equal(r.options[0].detail, '説明A');
  assert.deepEqual(r.related, ['zone-23', 'press-221']);
  assert.deepEqual(acceptAdvice(null, QA_IDS), { options: [], related: [] });
});

test('関連する場面別Q&A（AIなしでも出す）：候補の種類から選び、どれも Q&A にある', () => {
  const cases = [
    [{ category: 'turnovers', team: 'us', situation: 'ターンオーバー（2-2-1プレス）', detail: '2-2-1プレス' }, 'press-221'],
    [{ category: 'turnovers', team: 'us', situation: 'ターンオーバー（1-2-2プレス）', detail: '1-2-2プレス' }, 'press-122'],
    [{ category: 'turnovers', team: 'us', situation: 'ターンオーバー' }, 'man-pressure'],
    [{ category: 'opp_hot', team: 'opp', situation: 'ゴール下' }, 'def-post'],
    [{ category: 'opp_hot', team: 'opp', situation: '左コーナー3P' }, 'def-closeout'],
    [{ category: 'opp_leader', team: 'opp', situation: '得点' }, 'def-ace'],
    [{ category: 'us_defense_eff', team: 'us', situation: '対2-3ゾーンの3P' }, 'zone-23'],
    [{ category: 'us_defense_eff', team: 'us', situation: '対1-3-1ゾーンのFG' }, 'zone-131'],
    [{ category: 'rebounds', us: 3, opp: 9 }, 'reb-boxout'],
    [{ category: 'foul_trouble', team: 'us', value: 4 }, 'game-foultrouble'],
  ];
  for (const [c, expected] of cases) {
    const ids = relatedQaFor(c);
    assert.ok(ids.includes(expected), `${JSON.stringify(c)} → ${ids}`);
    for (const id of ids) assert.ok(QA_IDS.includes(id), `${id} が Q&A にない`);
  }
  assert.deepEqual(relatedQaFor({ category: 'turnovers', team: 'opp' }), []);
  assert.deepEqual(relatedQaFor(null), []);
});

test('関連のまとめ：AI の選んだものが先、重複なし、最大3つ、存在するものだけ', () => {
  assert.deepEqual(mergeRelated(['zone-23', 'x'], ['zone-cold', 'zone-23', 'zone-32', 'zone-131'], QA_IDS), ['zone-23', 'zone-cold', 'zone-32']);
  assert.deepEqual(mergeRelated(undefined, ['def-ace'], QA_IDS), ['def-ace']);
});

test('5ファウルは「退場」と書く（推測で「ベンチ待機の可能性」などにしない）', () => {
  const live = { usDF: 'マンツー', oppDF: 'マンツー' };
  const events = [];
  for (let i = 1; i <= 5; i++) events.push(ev({ type: 'foul', team: 'opp', player: '10' }, i, 4, live));
  const c = buildCandidates(events, { quarter: 4 }).find((x) => x.category === 'opp_foul_trouble');
  assert.equal(c.situation, '5ファウルで退場');
  assert.equal(localLine(c), '相手#10、5ファウルで退場（4Q終了時）');
  assert.match(evidenceText(c), /個人ファウル 5（退場）/);
});
