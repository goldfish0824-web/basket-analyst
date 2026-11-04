// Cloudflare の画面（ダッシュボード）で作った Worker に、まるごと貼る1ファイル版を作る。
// insight.js を変えたら `node worker/make-dashboard.mjs` で作り直す（tests/worker.test.js が食い違いを見つける）。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const HEADER = `// ===== Cloudflare の画面で作った Worker に、このファイルをまるごと貼って「Deploy」する =====
// （insight.js と、いちばん下の入口を1つにしたもの。自動で作っているので、直接は直さない）

`;

export const FOOTER = `
// ===== 入口：/basket/insight だけを受ける =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/basket/insight') return handleInsight(request, env);
    return new Response('Not found', { status: 404 });
  },
};
`;

export function makeDashboard(insightSource) {
  return HEADER + insightSource.replace(/\s*$/, '\n') + FOOTER;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const src = readFileSync(path.join(here, 'insight.js'), 'utf8');
  writeFileSync(path.join(here, 'dashboard.js'), makeDashboard(src));
  console.log('worker/dashboard.js を作りました');
}
