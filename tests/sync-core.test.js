import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPush, planApply, workerBase, teamSettingsOf, teamSettingsChanged, isDemoGame, outboxKey, syncErrorText, SHARED_SETTING_KEYS,
} from '../js/sync-core.js';
import { generateDemo } from '../js/demo.js';

const game = (id, extra = {}) => ({ id, opponent: '架空高校', updatedAt: 100, ...extra });
const ev = (id, gameId, extra = {}) => ({ id, gameId, seq: 1, type: 'fg', ts: 50, updatedAt: 120, ...extra });

test('共有する設定：名簿のひな形・守備隊形・チェック項目・巻き戻し・Q&A のメモ・AIに伝えない項目（ログイン・AI接続・配色・時計は共有しない）', () => {
  const s = { rosterTemplate: [{ number: '4', name: 'A' }], defenses: ['マンツー'], checklistTemplate: [], rewindSec: 8, qaNotes: { x: 'm' }, aiExclude: { rebounds: true }, theme: 'light', workerUrl: 'https://x', staffPass: 'p', authToken: 't', authUser: {}, qaFavorites: ['a'], clockMode: 'running_to', recordAssists: true };
  assert.deepEqual(Object.keys(teamSettingsOf(s)).sort(), [...SHARED_SETTING_KEYS].sort());
  assert.equal(teamSettingsChanged(s, { ...s, theme: 'dark', authToken: 'u' }), false);
  assert.equal(teamSettingsChanged(s, { ...s, defenses: ['マンツー', '2-3ゾーン'] }), true);
  assert.equal(teamSettingsChanged(s, { ...s, aiExclude: { rebounds: false } }), true);
  assert.equal(teamSettingsChanged(s, { ...s, clockMode: 'official' }), false);
});

test('デモ試合は共有しない（印、または大会名で見分ける）', () => {
  assert.equal(isDemoGame(generateDemo({ seed: 1 }).game), true);
  assert.equal(isDemoGame({ tournament: 'デモ大会（架空）' }), true);
  assert.equal(isDemoGame(game('g1')), false);
});

test('送る形：試合を先に、記録、設定。消したものは「消した印」。デモは送らない', () => {
  const entries = [
    { key: outboxKey.event('e1'), kind: 'event', id: 'e1', gameId: 'g1', stamp: 130 },
    { key: outboxKey.game('g1'), kind: 'game', id: 'g1', stamp: 110 },
    { key: outboxKey.event('e2'), kind: 'event', id: 'e2', gameId: 'g1', stamp: 140 },
    { key: outboxKey.game('gx'), kind: 'game', id: 'gx', stamp: 150 },
    { key: outboxKey.game('demo'), kind: 'game', id: 'demo', stamp: 160 },
    { key: outboxKey.event('ed'), kind: 'event', id: 'ed', gameId: 'demo', stamp: 160 },
    { key: outboxKey.team(), kind: 'team', id: 'settings', stamp: 170 },
  ];
  const records = {
    games: new Map([['g1', game('g1')], ['demo', game('demo', { isDemo: true })]]),
    events: new Map([['e1', ev('e1', 'g1')], ['ed', ev('ed', 'demo')]]),
    settings: { defenses: ['マンツー'], authToken: 'secret' },
  };
  const { push, sent, skipped } = buildPush(entries, records);
  assert.deepEqual(push.games.map((g) => [g.id, !!g.deleted]), [['g1', false], ['gx', true]]);
  assert.equal(push.games[0].updatedAt, 110);
  assert.equal(JSON.parse(push.games[0].data).opponent, '架空高校');
  assert.deepEqual(push.events.map((e) => [e.id, e.gameId, !!e.deleted]), [['e1', 'g1', false], ['e2', 'g1', true]]);
  assert.equal(push.events[0].updatedAt, 130, '送る予定に入れた時刻のほうが新しければそちら');
  assert.deepEqual(JSON.parse(push.team.data), { defenses: ['マンツー'] });
  assert.ok(!push.team.data.includes('secret'), 'ログインの鍵は送らない');
  assert.deepEqual(skipped.map((s) => s.id).sort(), ['demo', 'ed']);
  assert.equal(sent.length, 5);
});

test('送る形：1回に送る数には上限がある（残りは次の回）', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ key: `e:e${i}`, kind: 'event', id: `e${i}`, gameId: 'g1', stamp: i + 1 }));
  const records = { games: new Map([['g1', game('g1')]]), events: new Map(entries.map((en) => [en.id, ev(en.id, 'g1')])), settings: {} };
  const { push, sent } = buildPush(entries, records, 2);
  assert.equal(push.events.length, 2);
  assert.deepEqual(sent.map((s) => s.id), ['e0', 'e1']);
});

test('受け取ったもの：端末で変えたばかり（送る予定が残っている）の記録には上書きしない', () => {
  const items = [
    { t: 'g', id: 'g1', data: JSON.stringify(game('g1')), deleted: false },
    { t: 'g', id: 'g2', data: '{}', deleted: true },
    { t: 'e', id: 'e1', gameId: 'g1', data: JSON.stringify(ev('e1', 'g1')), deleted: false },
    { t: 'e', id: 'e2', gameId: 'g1', data: JSON.stringify(ev('e2', 'g1')), deleted: false },
    { t: 'e', id: 'e3', gameId: 'g1', data: '{}', deleted: true },
    { t: 'e', id: 'bad', gameId: 'g1', data: 'not json', deleted: false },
    { t: 's', id: 'settings', data: JSON.stringify({ defenses: ['2-3ゾーン'], authToken: 'x' }), deleted: false },
  ];
  const plan = planApply(items, new Set([outboxKey.event('e2')]));
  assert.deepEqual(plan.putGames.map((g) => g.id), ['g1']);
  assert.deepEqual(plan.deleteGames, ['g2']);
  assert.deepEqual(plan.putEvents.map((e) => e.id), ['e1']);
  assert.deepEqual(plan.deleteEvents, ['e3']);
  assert.deepEqual(plan.team, { defenses: ['2-3ゾーン'] });
  assert.equal(plan.skipped, 1);
  assert.equal(planApply(items, new Set([outboxKey.team()])).team, null);
});

test('Worker の URL：末尾の /basket/insight を外す。https でなければ使わない', () => {
  assert.equal(workerBase('https://a.example.workers.dev/basket/insight/'), 'https://a.example.workers.dev');
  assert.equal(workerBase(' https://a.example/ '), 'https://a.example');
  assert.equal(workerBase('http://a.example'), null);
  assert.equal(workerBase('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(workerBase(''), null);
  assert.equal(workerBase('not a url'), null);
});

test('エラーの文言', () => {
  assert.match(syncErrorText('wrong_login'), /ID かパスワード/);
  assert.match(syncErrorText('db_not_configured'), /D1/);
  assert.equal(syncErrorText('http', 500), 'Worker でエラーが起きました（500）');
  assert.equal(syncErrorText('???'), '通信できません');
});

test('接続先：貼り付けた文から URL を取り出す、送るメッセージ、見出し', async () => {
  const { extractWorkerUrl, connectMessage, connectHost } = await import('../js/sync-core.js');
  const url = 'https://basket.example.workers.dev';
  assert.equal(extractWorkerUrl(url), url);
  assert.equal(extractWorkerUrl(`  ${url}/  `), url);
  assert.equal(extractWorkerUrl(`${url}/basket/insight`), url);
  const msg = connectMessage(url);
  assert.match(msg, /接続先/);
  assert.equal(extractWorkerUrl(msg), url, 'メッセージをまるごと貼っても取り出せる');
  assert.equal(extractWorkerUrl(`接続先は「${url}」です。`), url);
  assert.equal(extractWorkerUrl(`see ${url}.`), url);
  assert.equal(extractWorkerUrl('http://evil.example.com'), null, 'https でないものは使わない');
  assert.equal(extractWorkerUrl('URLがありません'), null);
  assert.equal(extractWorkerUrl(''), null);
  assert.equal(connectMessage('not a url'), '');
  assert.equal(connectHost(url), 'basket.example.workers.dev');
  assert.equal(connectHost(''), '');
});
