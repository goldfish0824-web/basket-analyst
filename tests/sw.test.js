import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    const p = join(root, dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(relative(root, p)));
    else out.push(relative(root, p).split('\\').join('/'));
  }
  return out;
}

function precacheList() {
  const src = readFileSync(join(root, 'sw.js'), 'utf8');
  const m = src.match(/const ASSETS = \[([\s\S]*?)\];/);
  assert.ok(m, 'sw.js に ASSETS がない');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('オフライン用のキャッシュ一覧に、アプリのファイルがすべて入っている', () => {
  const assets = new Set(precacheList().map((a) => a.replace(/^\.\//, '')));
  const needed = [
    'index.html', 'manifest.webmanifest',
    ...listFiles('css'), ...listFiles('js'), ...listFiles('icons'),
  ];
  for (const f of needed) assert.ok(assets.has(f), `sw.js の ASSETS に ${f} がない`);
});

test('キャッシュ一覧のファイルはすべて存在する', () => {
  for (const a of precacheList()) {
    const p = a.replace(/^\.\//, '');
    if (p === '') continue;
    assert.ok(existsSync(join(root, p)), `${p} が存在しない`);
  }
});

test('manifest のアイコンが存在する', () => {
  const m = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone');
  for (const icon of m.icons) assert.ok(existsSync(join(root, icon.src)), icon.src);
});

test('リポジトリに API キーや Worker の URL の実値を書いていない', () => {
  const files = ['index.html', 'sw.js', ...listFiles('js')];
  for (const f of files) {
    const src = readFileSync(join(root, f), 'utf8');
    assert.ok(!/sk-ant-[A-Za-z0-9]/.test(src), `${f} に API キーらしき文字列`);
    assert.ok(!/https:\/\/[^'"\s]*workers\.dev/.test(src), `${f} に Worker の URL`);
  }
});

test('印刷用 PDF を開いたときは、アプリの画面（index.html）に置き換えない', () => {
  const src = readFileSync(join(root, 'sw.js'), 'utf8');
  const m = src.match(/function isAppPage\(pathname\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'sw.js に isAppPage がない');
  const isAppPage = new Function('pathname', m[1]);
  assert.equal(isAppPage('/basket-analyst/'), true);
  assert.equal(isAppPage('/basket-analyst/index.html'), true);
  assert.equal(isAppPage('/basket-analyst/print/qa.pdf'), false);
  assert.match(src, /req\.mode === 'navigate' && isAppPage\(url\.pathname\)/);
});
