// Cloudflare の画面（ダッシュボード）で作った Worker に、まるごと貼る1ファイル版を作る。
// auth.js・insight.js・sync.js を順につなぎ、ファイル同士の import を外して、いちばん下に入口を付ける。
// どれかを変えたら `node worker/make-dashboard.mjs` で作り直す（tests/worker.test.js が食い違いを見つける）。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const SOURCES = ['auth.js', 'insight.js', 'sync.js'];

export const HEADER = `// ===== Cloudflare の画面で作った Worker に、このファイルをまるごと貼って「Deploy」する =====
// （auth.js・insight.js・sync.js と、いちばん下の入口を1つにしたもの。自動で作っているので、直接は直さない）

`;

export const FOOTER = `
// ===== 入口：/basket/ で始まる道（AI・ログイン・同期）を受ける =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/basket/')) return handleBasket(request, env);
    return new Response('Not found', { status: 404 });
  },
};
`;

/** ファイル同士の import（'./…'）と、ほかのファイルからの export { … } from を外す */
export function stripLocalImports(source) {
  return source
    .replace(/^import \{[^}]*\} from '\.\/[a-z-]+\.js';\n/gm, '')
    .replace(/^export \{[^}]*\};\n/gm, '');
}

/** sources：{ 'auth.js': 中身, … } */
export function makeDashboard(sources) {
  const body = SOURCES.map((name) => `// ----- ${name} -----\n${stripLocalImports(sources[name]).replace(/\s*$/, '\n')}`).join('\n');
  return HEADER + body + FOOTER;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sources = Object.fromEntries(SOURCES.map((name) => [name, readFileSync(path.join(here, name), 'utf8')]));
  writeFileSync(path.join(here, 'dashboard.js'), makeDashboard(sources));
  console.log('worker/dashboard.js を作りました');
}
