import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseYouTubeId, youtubeUrlAt, parseClock, formatClock, quarterStartTs, videoFor, videoSeconds, videoLink,
  filterPlays, elapsedText, metricValue, evaluateTarget, targetText, mergeChecklist, CHECK_METRICS, CHECK_EXAMPLES,
  videoQuarterOptions, videoScopeLabel, PLAY_KINDS,
} from '../js/review.js';
import { generateDemo } from '../js/demo.js';
import { teamBox } from '../js/stats.js';

test('YouTube の URL から ID を取り出す（3つの形式）', () => {
  assert.equal(parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeId('https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=30'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeId('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeId('https://youtu.be/dQw4w9WgXcQ?si=abc&t=5'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeId('youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeId('https://www.youtube.com/live/AbCdEf12345?si=x'), 'AbCdEf12345');
  assert.equal(parseYouTubeId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseYouTubeId('https://www.youtube.com/channel/UC123'), null);
  assert.equal(parseYouTubeId(''), null);
  assert.equal(parseYouTubeId('ただの文字'), null);
});

test('?t=秒 付きの URL', () => {
  assert.equal(youtubeUrlAt('dQw4w9WgXcQ', 754.9), 'https://youtu.be/dQw4w9WgXcQ?t=754');
  assert.equal(youtubeUrlAt('dQw4w9WgXcQ', -3), 'https://youtu.be/dQw4w9WgXcQ?t=0');
});

test('「分:秒」「時:分:秒」の読み書き', () => {
  assert.equal(parseClock('12:34'), 754);
  assert.equal(parseClock('1:02:03'), 3723);
  assert.equal(parseClock('754'), 754);
  assert.equal(parseClock('０：３０'), 30);
  assert.equal(parseClock('0:00'), 0);
  assert.equal(parseClock('1:75'), null);
  assert.equal(parseClock('abc'), null);
  assert.equal(parseClock(''), null);
  assert.equal(formatClock(754), '12:34');
  assert.equal(formatClock(3723), '1:02:03');
  assert.equal(formatClock(5), '0:05');
});

// q_start が 1Q=1000s, 2Q=2000s（ミリ秒で）の試合
const events = [
  { seq: 1, type: 'q_start', quarter: 1, ts: 1_000_000 },
  { seq: 2, type: 'fg', quarter: 1, ts: 1_100_000, team: 'us', player: '4', made: true, points: 2 },
  { seq: 3, type: 'q_end', quarter: 1, ts: 1_700_000 },
  { seq: 4, type: 'q_start', quarter: 2, ts: 2_000_000 },
  { seq: 5, type: 'to', quarter: 2, ts: 2_030_000, team: 'us', player: '7' },
];

test('q_start の時刻（やり直しがあれば最後）', () => {
  assert.equal(quarterStartTs(events, 2), 2_000_000);
  assert.equal(quarterStartTs([...events, { seq: 9, type: 'q_start', quarter: 2, ts: 2_005_000 }], 2), 2_005_000);
  assert.equal(quarterStartTs(events, 3), null);
});

test('動画の秒数＝（ts − q_start）÷1000 ＋ 入力した秒数 − 巻き戻し（SPEC 6-1）', () => {
  const whole = { url: 'https://youtu.be/dQw4w9WgXcQ', quarter: null, offsetSec: 300 };
  // 1Q のシュート：100秒後 ＋ 300 − 8 ＝ 392
  assert.equal(videoSeconds(events[1], events, whole, 8), 392);
  // 試合全体の動画は試合開始（1Q）からの経過：2Q のターンオーバーは 1030秒後 ＋ 300 − 8
  assert.equal(videoSeconds(events[4], events, whole, 8), 1322);
  // クォーターごとの動画はそのクォーターの開始から
  const q2 = { url: 'https://youtu.be/AbCdEf12345', quarter: 2, offsetSec: 15 };
  assert.equal(videoSeconds(events[4], events, q2, 8), 37);
  // 0 より前にはしない
  assert.equal(videoSeconds(events[0], events, { ...whole, offsetSec: 0 }, 8), 0);
  // q_start がなければ出せない
  assert.equal(videoSeconds({ quarter: 3, ts: 5 }, events, { ...q2, quarter: 3 }, 8), null);
});

test('対応する動画：そのクォーターの動画 ＞ 試合全体の動画', () => {
  const videos = [
    { url: 'https://youtu.be/WholeGame01', quarter: null, offsetSec: 0 },
    { url: 'https://youtu.be/Quarter2Vid', quarter: 2, offsetSec: 10 },
    { url: 'not a url', quarter: 1, offsetSec: 0 },
  ];
  assert.equal(videoFor(events[4], videos).url, 'https://youtu.be/Quarter2Vid');
  assert.equal(videoFor(events[1], videos).url, 'https://youtu.be/WholeGame01'); // 1Q の URL は読めないので全体
  assert.equal(videoFor(events[1], []), null);
  const link = videoLink(events[4], events, videos, 8);
  assert.deepEqual([link.url, link.sec], ['https://youtu.be/Quarter2Vid?t=32', 32]);
  assert.equal(videoLink(events[4], events, [], 8), null);
});

test('プレー一覧の絞り込み（ターンオーバーだけ、相手#7のシュートだけ など）', () => {
  const { events: ev } = generateDemo({ seed: 1 });
  const tos = filterPlays(ev, { kind: 'to', team: 'us' });
  assert.ok(tos.length > 0 && tos.every((e) => e.type === 'to' && e.team === 'us'));
  const opp7 = filterPlays(ev, { team: 'opp', player: '7', kind: 'shot' });
  assert.ok(opp7.length >= 8 && opp7.every((e) => e.type === 'fg' && e.player === '7'));
  const press = filterPlays(ev, { team: 'us', kind: 'to', defense: '2-2-1プレス' });
  assert.equal(press.length, 4);
  const h1Made = filterPlays(ev, { kind: 'shot_made', quarter: 'H1' });
  assert.ok(h1Made.every((e) => e.made && e.quarter <= 2));
  const qs = filterPlays(ev, { kind: 'quarter' });
  assert.equal(qs.length, 8);
  // seq 順
  const all = filterPlays([...ev].reverse());
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].seq < all[i].seq);
  assert.ok(PLAY_KINDS.every((k) => !/TO/.test(k.label)));
});

test('クォーター開始からの経過', () => {
  assert.equal(elapsedText(events[4], events), '+0:30');
  assert.equal(elapsedText({ quarter: 3, ts: 1 }, events), '');
});

test('チェックポイントの数字', () => {
  const { events: ev } = generateDemo({ seed: 1 });
  const us = teamBox(ev, 'us').total;
  const opp = teamBox(ev, 'opp').total;
  assert.equal(metricValue('us_to', ev), us.to);
  assert.equal(metricValue('opp_or', ev), opp.oreb);
  assert.equal(metricValue('opp_pts', ev), opp.pts);
  assert.ok(Math.abs(metricValue('us_fg_pct', ev) - (us.fgm / us.fga) * 100) < 1e-9);
  assert.equal(metricValue('nope', ev), null);
  assert.equal(metricValue('us_3p_pct', []), null); // 試投0
  for (const m of CHECK_METRICS) assert.ok(!/TO/.test(m.label), m.label);
});

test('目標の自動判定（◯／×）', () => {
  const { events: ev } = generateDemo({ seed: 1 });
  const usTo = metricValue('us_to', ev);
  const ok = evaluateTarget({ key: 'us_to', op: 'le', value: usTo }, ev);
  assert.deepEqual([ok.ok, ok.mark], [true, '◯']);
  assert.equal(ok.text, `自チームのターンオーバー ${usTo}本（目標 ${usTo}本以下）`);
  const ng = evaluateTarget({ key: 'us_to', op: 'le', value: usTo - 1 }, ev);
  assert.deepEqual([ng.ok, ng.mark], [false, '×']);
  const ge = evaluateTarget({ key: 'us_fg_pct', op: 'ge', value: 50 }, ev);
  assert.equal(ge.ok, metricValue('us_fg_pct', ev) >= 50);
  assert.match(ge.text, /%（目標 50%以上）$/);
  assert.equal(evaluateTarget({ key: 'us_3p_pct', op: 'ge', value: 30 }, []).ok, null);
  assert.equal(evaluateTarget(null, ev).ok, null);
  assert.equal(evaluateTarget({ key: 'us_to', op: 'le', value: '' }, ev).ok, null);
  assert.equal(targetText({ key: 'opp_or', op: 'le', value: 8 }), '相手のOR 8本以下');
});

test('試合のチェックとテンプレートを合わせる', () => {
  const template = [
    { id: 't1', label: 'ボックスアウト', target: null },
    { id: 't2', label: 'ターンオーバー12以下', target: { key: 'us_to', op: 'le', value: 12 } },
  ];
  const fresh = mergeChecklist([], template);
  assert.equal(fresh.saved, false);
  assert.deepEqual(fresh.items.map((i) => [i.itemId, i.mark, i.memo]), [['t1', null, ''], ['t2', null, '']]);
  const saved = mergeChecklist([{ itemId: 't1', label: 'ボックスアウト（旧）', target: null, mark: '△', memo: '3Qに減った' }], template);
  assert.equal(saved.saved, true);
  assert.equal(saved.items[0].label, 'ボックスアウト（旧）'); // 評価したときの項目名のまま
  assert.deepEqual(saved.missing.map((t) => t.id), ['t2']);
});

test('チェック項目の例と動画の対象', () => {
  assert.equal(CHECK_EXAMPLES.length, 5);
  assert.deepEqual(videoQuarterOptions().map((o) => o.label), ['試合全体', '1Q', '2Q', '3Q', '4Q', '延長1', '延長2']);
  assert.equal(videoScopeLabel(null), '試合全体');
  assert.equal(videoScopeLabel(5), '延長1');
});
