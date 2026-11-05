import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { QA_ITEMS, QA_CATEGORIES, unitDiagrams, itemDiagrams } from '../js/qa.js';
import { printPlan, diagramCount, splitMove } from '../js/qa-print.js';

const all = () => printPlan().flatMap((s) => s.items);

test('印刷：全42場面をカテゴリの順に、No.1 から通し番号で載せる', () => {
  const sections = printPlan();
  const order = QA_CATEGORIES.map((c) => c.key).filter((k) => QA_ITEMS.some((i) => i.cat === k));
  assert.deepEqual(sections.map((s) => s.key), order);
  const entries = sections.flatMap((s) => s.items);
  assert.equal(entries.length, QA_ITEMS.length);
  assert.deepEqual(entries.map((e) => e.no), QA_ITEMS.map((_, i) => i + 1));
  assert.equal(new Set(entries.map((e) => e.id)).size, QA_ITEMS.length);
  for (const s of sections) for (const e of s.items) assert.equal(e.item.cat, s.key);
});

test('印刷：左右反対の形は mirror の場面（終盤のサイドセット）だけに付く', () => {
  for (const e of all()) {
    assert.equal(e.versions[0].label, '');
    assert.equal(e.versions[0].item, e.item);
    if (e.item.mirror === true) {
      assert.equal(e.versions.length, 2, e.id);
      assert.equal(e.versions[1].label, '左右を反対にした形');
      // 左右反対の図は x が 15−x になっている
      const a = unitDiagrams(e.item.patterns[0])[0].diagram;
      const b = unitDiagrams(e.versions[1].item.patterns[0])[0].diagram;
      assert.ok(Math.abs(b.offense[0][0] - (15 - a.offense[0][0])) < 1e-6);
      assert.equal(b.offense[0][1], a.offense[0][1]);
    } else {
      assert.equal(e.versions.length, 1, e.id);
    }
  }
  assert.deepEqual(all().filter((e) => e.versions.length > 1).map((e) => e.id), ['set-2', 'set-3']);
});

test('印刷：パターン・手順・左右反対の図をすべて数える', () => {
  const byId = Object.fromEntries(all().map((e) => [e.id, e]));
  // ゾーンプレスは3パターン、2-3ゾーンは5パターン
  assert.equal(diagramCount(byId['press-221']), 3);
  assert.equal(diagramCount(byId['zone-23']), 5);
  // 終盤のセットは（2パターン×2手順）×左右の2つ
  assert.equal(diagramCount(byId['set-2']), 8);
  assert.equal(diagramCount(byId['set-3']), 8);
  for (const e of all()) {
    const one = Array.isArray(e.item.patterns) ? e.item.patterns.reduce((s, p) => s + unitDiagrams(p).length, 0) : itemDiagrams(e.item).length;
    assert.equal(diagramCount(e), one * e.versions.length, e.id);
  }
});

test('印刷：動きの説明の①〜⑨を番号と本文に分ける', () => {
  assert.deepEqual(splitMove('①4から1へスローイン。'), { n: 1, text: '4から1へスローイン。' });
  assert.deepEqual(splitMove('⑨最後'), { n: 9, text: '最後' });
  assert.deepEqual(splitMove('番号のない説明'), { n: null, text: '番号のない説明' });
  assert.deepEqual(splitMove(''), { n: null, text: '' });
});

test('印刷：Q&A画面からリンクしている PDF（print/qa.pdf）がある', () => {
  const file = new URL('../print/qa.pdf', import.meta.url);
  assert.ok(existsSync(file), 'node tools/make-qa-pdf.cjs で作る');
  assert.equal(readFileSync(file).subarray(0, 5).toString('latin1'), '%PDF-');
});
