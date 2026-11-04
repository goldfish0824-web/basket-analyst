// 単独で動かすときの入口（wrangler 用）。既存の中継 Worker に組み込む場合は README.md の手順で handleBasket を呼ぶ
import { handleBasket } from './sync.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/basket/')) return handleBasket(request, env);
    return new Response('Not found', { status: 404 });
  },
};
