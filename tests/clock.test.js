import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quarterSeconds, newClock, isRunning, remainingAt, startClock, stopClock, setRemaining, adjustClock, settleClock,
  clockForEvent, formatClock, parseClock,
} from '../js/clock.js';

test('時計：クォーターは10分、延長は5分（設定で変えられる）', () => {
  assert.equal(quarterSeconds(1), 600);
  assert.equal(quarterSeconds(4), 600);
  assert.equal(quarterSeconds(5), 300);
  assert.equal(quarterSeconds(2, { quarterMin: 8 }), 480);
  assert.equal(quarterSeconds(5, { otMin: 3 }), 180);
  assert.equal(quarterSeconds(1, { quarterMin: 'x' }), 600);
});

test('時計：動かす・止める・残り時間', () => {
  const t0 = 1_000_000;
  let c = newClock(1, 600);
  assert.equal(isRunning(c), false);
  assert.equal(remainingAt(c, t0 + 5000), 600);
  c = startClock(c, t0);
  assert.equal(isRunning(c), true);
  assert.equal(remainingAt(c, t0 + 12_300), 587.7);
  c = stopClock(c, t0 + 12_300);
  assert.equal(isRunning(c), false);
  assert.equal(c.remaining, 587.7);
  assert.equal(remainingAt(c, t0 + 60_000), 587.7, '止めている間は減らない');
  c = startClock(c, t0 + 60_000);
  assert.equal(remainingAt(c, t0 + 70_000), 577.7);
  // 2回押しても変わらない
  assert.equal(startClock(c, t0 + 65_000), c);
  assert.equal(stopClock(stopClock(c, t0 + 70_000), t0 + 80_000).remaining, 577.7);
});

test('時計：0 で止まり、マイナスにならない', () => {
  let c = startClock(newClock(4, 600), 0);
  assert.equal(remainingAt(c, 700_000), 0);
  c = settleClock(c, 700_000);
  assert.equal(isRunning(c), false);
  assert.equal(c.remaining, 0);
  assert.equal(startClock(c, 800_000), c, '0 のときは動かさない');
});

test('時計：残り時間を合わせる（動いていれば動いたまま、0〜長さに収める）', () => {
  const c = startClock(newClock(2, 600), 0);
  const a = setRemaining(c, 332, 10_000);
  assert.equal(isRunning(a), true);
  assert.equal(remainingAt(a, 15_000), 327);
  assert.equal(setRemaining(newClock(2, 600), 900, 0).remaining, 600);
  assert.equal(setRemaining(newClock(2, 600), -5, 0).remaining, 0);
  const b = adjustClock(stopClock(c, 30_000), -10, 40_000);
  assert.equal(b.remaining, 560);
  assert.equal(isRunning(b), false);
  assert.equal(adjustClock(b, 1, 0).remaining, 561);
});

test('時計：イベントに付ける残り秒は、同じクォーターの時計があるときだけ', () => {
  const c = startClock(newClock(3, 600), 0);
  assert.equal(clockForEvent(c, 3, 4_560), 595.4);
  assert.equal(clockForEvent(c, 2, 4_560), null);
  assert.equal(clockForEvent(null, 3, 0), null);
});

test('時計：表示は分:秒（端数は切り上げ）', () => {
  assert.equal(formatClock(600), '10:00');
  assert.equal(formatClock(599.6), '10:00');
  assert.equal(formatClock(599), '9:59');
  assert.equal(formatClock(65.2), '1:06');
  assert.equal(formatClock(0.3), '0:01');
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(null), '');
});

test('時計：「5:32」「５：３２」「7」を秒に直す', () => {
  assert.equal(parseClock('5:32'), 332);
  assert.equal(parseClock('５：３２'), 332);
  assert.equal(parseClock('10:00'), 600);
  assert.equal(parseClock('7'), 420);
  assert.equal(parseClock('5:75'), null);
  assert.equal(parseClock('abc'), null);
});
