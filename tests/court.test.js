import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isThree, zoneOf, inPaint, angleFromFront, clampToCourt, pointsForZone, zonePolygons, ZONES,
  ZONE_LABEL_POS, CORNER_JOIN_DEG, arcPoint,
} from '../js/court.js';

test('ペイント内はゴール下', () => {
  assert.equal(zoneOf(7.5, 3), 'ゴール下');
  assert.equal(zoneOf(5.05, 0.5), 'ゴール下'); // 境界線上はペイント内
  assert.equal(zoneOf(9.95, 5.8), 'ゴール下');
  assert.ok(inPaint(6, 5));
  assert.ok(!inPaint(4.9, 5));
});

test('3Pライン内側でペイント外はミドル（x で左右中央）', () => {
  assert.equal(zoneOf(3, 3), 'ミドル左');
  assert.equal(zoneOf(12, 3), 'ミドル右');
  assert.equal(zoneOf(7.5, 7), 'ミドル中央');
  assert.equal(zoneOf(5.0, 7.5), 'ミドル左'); // FTラインより上でも x<5.05 は左
  assert.equal(zoneOf(10.0, 7.5), 'ミドル右');
  assert.equal(zoneOf(6, 6.5), 'ミドル中央');
});

test('コーナー3P：y≦2.99 かつ横6.6m超', () => {
  assert.equal(zoneOf(0.5, 1), '3P左コーナー');
  assert.equal(zoneOf(14.5, 1), '3P右コーナー');
  assert.equal(zoneOf(0.89, 2.99), '3P左コーナー');
  // 横ちょうど6.6m（x=0.9）はライン上なので2P
  assert.equal(isThree(0.9, 2), false);
  assert.equal(zoneOf(0.9, 2), 'ミドル左');
  assert.equal(isThree(14.1, 2), false);
  assert.equal(isThree(14.11, 2), true);
});

test('弧の上は2P、弧の外は3P', () => {
  assert.equal(isThree(7.5, 1.575 + 6.75), false);
  assert.equal(isThree(7.5, 1.575 + 6.76), true);
  assert.equal(zoneOf(7.5, 8.33), '3Pトップ');
  assert.equal(zoneOf(7.5, 8.3), 'ミドル中央');
});

test('直線部分の上端 y=2.99 で弧とつながる（寸法の丸めで1mm未満の差）', () => {
  const p = arcPoint(-CORNER_JOIN_DEG);
  assert.ok(Math.abs(p.x - 0.9) < 1e-3);
  assert.ok(Math.abs(p.y - 2.99) < 1e-3);
});

test('3Pトップ／45度は正面±22.5度で分かれる', () => {
  assert.equal(zoneOf(7.5, 9), '3Pトップ');
  assert.equal(zoneOf(2, 8), '3P左45度');
  assert.equal(zoneOf(13, 8), '3P右45度');
  // 22.5度ちょうどはトップ
  const rad = (22.5 * Math.PI) / 180;
  const r = 8;
  const x = 7.5 + r * Math.sin(rad);
  const y = 1.575 + r * Math.cos(rad);
  assert.ok(Math.abs(angleFromFront(x, y) - 22.5) < 1e-9);
  assert.equal(zoneOf(x - 1e-6, y), '3Pトップ');
  assert.equal(zoneOf(x + 0.05, y), '3P右45度');
  // y が 2.99 を超えるとサイドライン際でもコーナーではない
  assert.equal(zoneOf(0.5, 3.5), '3P左45度');
});

test('2P⇄3P の切り替えでゾーンを寄せる', () => {
  // 3Pライン少し内側を3Pにした
  assert.equal(zoneOf(7.5, 8.2, true), '3Pトップ');
  assert.equal(zoneOf(1.2, 2.0, true), '3P左コーナー');
  assert.equal(zoneOf(13.5, 6.2, true), '3P右45度');
  // 3Pライン少し外側を2Pにした
  assert.equal(zoneOf(7.5, 8.5, false), 'ミドル中央');
  assert.equal(zoneOf(0.5, 1.0, false), 'ミドル左');
  assert.equal(zoneOf(14.0, 6.0, false), 'ミドル右');
  // 自動判定と同じ指定なら結果も同じ
  assert.equal(zoneOf(2, 8, true), zoneOf(2, 8));
  assert.equal(zoneOf(7.5, 3, false), zoneOf(7.5, 3));
});

test('点数はゾーンから決まる', () => {
  assert.equal(pointsForZone('3Pトップ'), 3);
  assert.equal(pointsForZone('ミドル右'), 2);
  assert.equal(pointsForZone('ゴール下'), 2);
});

test('コートの外をタップしたら内側に寄せる', () => {
  assert.deepEqual(clampToCourt(-1, 20), { x: 0, y: 14 });
  assert.deepEqual(clampToCourt(7, 7), { x: 7, y: 7 });
});

test('格子のすべての点で、2P/3P とゾーンの種類が一致する', () => {
  for (let x = 0; x <= 15; x += 0.1) {
    for (let y = 0; y <= 14; y += 0.1) {
      const z = zoneOf(x, y);
      assert.ok(ZONES.includes(z));
      assert.equal(pointsForZone(z) === 3, isThree(x, y), `(${x}, ${y}) ${z}`);
    }
  }
});

// 多角形の内外判定（描画用の形がゾーン判定と合っているかの確認）
function inPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

test('描画用のゾーン多角形はゾーン判定と一致する（境界付近を除く）', () => {
  const polys = zonePolygons();
  let checked = 0;
  for (let x = 0.13; x < 15; x += 0.37) {
    for (let y = 0.11; y < 14; y += 0.37) {
      const z = zoneOf(x, y);
      const hits = ZONES.filter((name) => inPolygon(polys[name], x, y));
      // 弧を折れ線で近似しているので、境界ぎりぎりの点は複数／0 になることがある
      if (hits.length === 1) {
        assert.equal(hits[0], z, `(${x.toFixed(2)}, ${y.toFixed(2)})`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 1300);
});

test('ゾーンのラベル位置はそれぞれのゾーンの中', () => {
  for (const z of ZONES) {
    const p = ZONE_LABEL_POS[z];
    assert.equal(zoneOf(p.x, p.y), z, z);
  }
});
