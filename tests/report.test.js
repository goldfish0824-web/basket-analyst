import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportPayload, acceptReport, reportText, cleanNote, MAX_COACH_NOTE } from '../js/report.js';
import { generateDemo } from '../js/demo.js';

function demo() {
  const { game, events } = generateDemo({ seed: 11 });
  game.opponent = 'さくら台高校（架空）';
  game.checklist = [
    { itemId: 'a', label: 'ボックスアウト', mark: '△', memo: '#4ユイが外された', target: null },
    { itemId: 'b', label: 'ターンオーバーを減らす', mark: null, memo: '', target: { key: 'us_to', op: 'le', value: 12 } },
    { itemId: 'c', label: '対象外の項目', mark: '◯', memo: '', active: false },
  ];
  game.insights = [
    { quarter: 2, inProgress: false, createdAt: 2, items: [{ line: '相手#7、右ドライブで5本中4本成功' }] },
    { quarter: 2, inProgress: false, createdAt: 1, items: [{ line: '古い結果' }] },
    { quarter: 3, inProgress: true, createdAt: 3, items: [{ line: 'タイムアウト中の途中結果' }] },
  ];
  return { game, events };
}

test('ふりかえりで送る形：点数・チーム合計・背番号ごと・隊形別・場所別・種類・特筆データ・チェック項目', () => {
  const { game, events } = demo();
  const p = buildReportPayload({ game, events, defenses: ['マンツー', '2-3ゾーン'], coachNote: '  次は県大会\n\n\n\nゾーン対策  ' });
  assert.equal(p.kind, 'game_report');
  assert.ok(p.score.us + p.score.opp > 0);
  assert.equal(p.score.byQuarter.us.length, p.score.byQuarter.opp.length);
  assert.ok(Array.isArray(p.us.fg) && p.us.fg.length === 2);
  assert.ok(p.players.length > 0 && p.players.every((x) => /^#\d+$/.test(x.no)));
  assert.ok(p.byDefense.length > 0 && p.zones.length > 0);
  // 特筆データは各クォーターの最新だけ、途中の結果は入れない
  assert.deepEqual(p.insights, [{ quarter: '2Q', line: '相手#7、右ドライブで5本中4本成功' }]);
  // チェック項目：対象の項目だけ、評価と目標の自動判定（メモは送らない）
  assert.equal(p.checklist.length, 2);
  assert.deepEqual(p.checklist[0], { label: 'ボックスアウト', mark: '△' });
  assert.match(p.checklist[1].auto, /ターンオーバー/);
  assert.equal(p.coachNote, '次は県大会\n\nゾーン対策');
});

test('ふりかえりで送る形：選手の名前・相手校名・メモは入らない', () => {
  const { game, events } = demo();
  const text = JSON.stringify(buildReportPayload({ game, events }));
  for (const r of game.roster) if (r.name) assert.ok(!text.includes(r.name), r.name);
  assert.ok(!text.includes('さくら台'));
  assert.ok(!text.includes('外された'));
  assert.ok(!/memo|name|opponent/.test(text));
});

test('メモは400字まで', () => {
  assert.equal(cleanNote('あ'.repeat(1000)).length, MAX_COACH_NOTE);
  assert.equal(cleanNote(null), '');
});

const sample = {
  summary: '前半はリードしたが、後半はターンオーバーが増えた。',
  good: [{ point: 'ゴール下の確率が高い', evidence: 'ゴール下 7本中6本' }, { point: '', evidence: '捨てる' }],
  issues: [{ point: '後半のターンオーバー', evidence: '後半 9本' }],
  practice: [
    { issue: 'ターンオーバー', menu: '3対2のプレス突破', detail: '中央に1人入れて、2本以内のパスで運ぶ。', minutes: 15 },
    { issue: 'x', menu: '', detail: '名前がないので捨てる', minutes: 10 },
  ],
  watch: ['後半のターンオーバー', ''],
};

test('応答：空の項目を捨てて、長さと数をそろえる。良かった点も課題もなければ null', () => {
  const r = acceptReport(sample);
  assert.equal(r.good.length, 1);
  assert.equal(r.issues.length, 1);
  assert.equal(r.practice.length, 1);
  assert.equal(r.practice[0].minutes, 15);
  assert.deepEqual(r.watch, ['後半のターンオーバー']);
  assert.equal(acceptReport({ summary: 'x', good: [], issues: [] }), null);
  assert.equal(acceptReport(null), null);
});

test('コピー用の文章：見出しと項目、最後に「決めるのはコーチ」', () => {
  const t = reportText(acceptReport(sample), { opponent: 'さくら台高校（架空）', date: '2026/11/3（火）', score: { us: 38, opp: 42 } });
  const lines = t.split('\n');
  assert.equal(lines[0], '【AIふりかえり】 vs さくら台高校（架空） 2026/11/3（火） 38-42');
  assert.ok(t.includes('■良かった点\n・ゴール下の確率が高い（ゴール下 7本中6本）'));
  assert.ok(t.includes('・3対2のプレス突破（15分）［ターンオーバー］：中央に1人入れて、2本以内のパスで運ぶ。'));
  assert.ok(t.endsWith('決めるのはコーチです。'));
  assert.ok(!/すべき/.test(t));
});
