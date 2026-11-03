import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackup, parseBackup, backupFileName } from '../js/backup.js';
import { generateDemo } from '../js/demo.js';

test('書き出し → 読み込みで元に戻る', () => {
  const { game, events } = generateDemo({ seed: 3, now: Date.UTC(2026, 10, 3) });
  const settings = { rosterTemplate: [{ number: '4', name: 'テスト' }], defenses: ['マンツー'] };
  const json = JSON.stringify(buildBackup({ games: [game], events, settings }, Date.UTC(2026, 10, 3)));
  const back = parseBackup(json);
  assert.deepEqual(back.games, [game]);
  assert.deepEqual(back.events, events);
  assert.deepEqual(back.settings, settings);
  assert.equal(back.skipped, 0);
});

test('試合ごとの書き出しには設定を含めない', () => {
  const out = buildBackup({ games: [], events: [] });
  assert.equal(out.settings, undefined);
  assert.equal(out.app, 'basket-analyst');
});

test('別のファイルは日本語のエラーで断る', () => {
  assert.throws(() => parseBackup('not json'), /JSON/);
  assert.throws(() => parseBackup('{"foo":1}'), /このアプリ/);
  assert.throws(() => parseBackup('{"app":"basket-analyst","format":99,"games":[],"events":[]}'), /新しい版/);
  assert.throws(() => parseBackup('{"app":"basket-analyst","format":1}'), /試合データ/);
  assert.throws(() => parseBackup('{"app":"basket-analyst","format":1,"games":[{}],"events":[]}'), /ID/);
});

test('試合が見つからない・形が違うイベントは読み飛ばして数を返す', () => {
  const data = {
    app: 'basket-analyst',
    format: 1,
    games: [{ id: 'g1', date: '2026-11-01' }],
    events: [
      { id: 'e1', gameId: 'g1', seq: 1, type: 'q_start', quarter: 1 },
      { id: 'e2', gameId: 'zz', seq: 2, type: 'fg' },
      { id: 'e3', gameId: 'g1', seq: 3, type: 'unknown' },
    ],
  };
  const r = parseBackup(JSON.stringify(data));
  assert.equal(r.events.length, 1);
  assert.equal(r.skipped, 2);
  assert.deepEqual(r.events[0].tags, []);
  // 足りない項目は空で補う
  assert.deepEqual(r.games[0].insights, []);
  assert.deepEqual(r.games[0].roster, []);
});

test('ファイル名', () => {
  const now = new Date(2026, 10, 3, 9, 5).getTime();
  assert.equal(backupFileName([{ date: '2026-11-01', opponent: 'さくら台 高校' }], now), 'basket-20261101-さくら台_高校.json');
  assert.equal(backupFileName([{}, {}], now), 'basket-all-20261103-0905.json');
});
