import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name);
    if (statSync(join(root, rel)).isDirectory()) out.push(...jsFiles(rel));
    else if (name.endsWith('.js')) out.push(rel);
  }
  return out;
}

// 画面のモジュール（ブラウザでしか動かないもの）も、書き間違いがないかだけは確かめる
test('すべての JS ファイルに文法の誤りがない', () => {
  const files = [...jsFiles('js'), ...jsFiles('worker'), 'sw.js'];
  assert.ok(files.length > 20);
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', join(root, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}\n${r.stderr}`);
  }
});
