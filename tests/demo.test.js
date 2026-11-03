import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo, seededRandom, pointInZone, DEMO_ROSTER } from '../js/demo.js';
import { zoneOf, isThree, ZONES } from '../js/court.js';
import { EVENT_TYPES, quarterState } from '../js/model.js';
import { scoreOf, scoreByQuarter, playerFouls, teamBox, byDefense } from '../js/stats.js';

function demo() {
  let n = 0;
  return generateDemo({ seed: 1, now: new Date('2026-11-03T12:00:00').getTime(), newId: () => `id${++n}` });
}

test('約120イベント、4クォーターすべてに開始と終了', () => {
  const { game, events } = demo();
  assert.ok(events.length >= 100 && events.length <= 140, `イベント数 ${events.length}`);
  for (let q = 1; q <= 4; q++) {
    assert.equal(events.filter((e) => e.type === 'q_start' && e.quarter === q).length, 1);
    assert.equal(events.filter((e) => e.type === 'q_end' && e.quarter === q).length, 1);
  }
  assert.deepEqual(quarterState(events), { phase: 'break', quarter: 4, next: 5 });
  assert.equal(game.date, '2026-11-03');
  assert.ok(game.isDemo);
});

test('イベントの形がそろっている', () => {
  const { game, events } = demo();
  let prevSeq = 0;
  let prevTs = 0;
  for (const e of events) {
    assert.equal(e.gameId, game.id);
    assert.ok(EVENT_TYPES.includes(e.type), e.type);
    assert.ok(e.seq > prevSeq);
    assert.ok(e.ts > prevTs);
    prevSeq = e.seq;
    prevTs = e.ts;
    if (e.type === 'fg') {
      assert.equal(zoneOf(e.x, e.y), e.zone, `seq ${e.seq}`);
      assert.equal(e.points, isThree(e.x, e.y) ? 3 : 2);
      assert.ok(e.defense);
    }
  }
});

test('同じ seed なら同じデータ', () => {
  const a = demo();
  const b = demo();
  assert.deepEqual(a.events, b.events);
});

test('デモの名前は架空の呼び名だけ（カタカナ）', () => {
  for (const p of DEMO_ROSTER) assert.match(p.name, /^[ァ-ヶー]+$/);
});

test('集計に使える偏りが入っている', () => {
  const { game, events } = demo();
  const score = scoreOf(events);
  const byQ = scoreByQuarter(events);
  assert.equal(byQ.us.reduce((a, b) => a + b, 0), score.us);
  assert.equal(byQ.opp.reduce((a, b) => a + b, 0), score.opp);
  // 2Q の得点差が8以上
  assert.ok(Math.abs(byQ.us[1] - byQ.opp[1]) >= 8);
  // 対2-3ゾーンの3Pが入らない
  const zone = byDefense(events, 'us').find((r) => r.defense === '2-3ゾーン');
  assert.ok(zone.tpa >= 8 && zone.tpm <= 1);
  // 2-2-1プレスでターンオーバーが4本以上
  const press = byDefense(events, 'us').find((r) => r.defense === '2-2-1プレス');
  assert.ok(press.to >= 4);
  // ファウルトラブル
  const pf = playerFouls(events);
  assert.equal(pf.us['5'], 4);
  assert.equal(pf.opp['10'], 5);
  // 相手#7 のドライブ
  const drives = events.filter((e) => e.type === 'fg' && e.team === 'opp' && e.player === '7' && e.tags.includes('ドライブ'));
  assert.ok(drives.length >= 5);
  // 自チームのFT 試投6以上で50%以下
  const box = teamBox(events, 'us', game.roster).total;
  assert.ok(box.fta >= 6 && box.ftm / box.fta <= 0.5);
});

test('ゾーン内の点を作る', () => {
  const rand = seededRandom(42);
  for (const z of ZONES) {
    for (let i = 0; i < 20; i++) {
      const p = pointInZone(z, rand);
      assert.equal(zoneOf(p.x, p.y), z);
    }
  }
});
