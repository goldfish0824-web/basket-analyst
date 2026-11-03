// 単独で動かすときの入口（既存の中継 Worker に組み込む場合は README.md の手順で handleInsight を呼ぶ）
import { handleInsight } from './insight.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/basket/insight') return handleInsight(request, env);
    return new Response('Not found', { status: 404 });
  },
};
