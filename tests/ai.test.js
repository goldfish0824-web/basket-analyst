import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insightEndpoint, requestInsights, testConnection, reasonText, isConfigured } from '../js/ai.js';

const settings = { workerUrl: 'https://relay.example.workers.dev', staffPass: 'pass' };

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) };
}

test('問い合わせ先の URL', () => {
  assert.equal(insightEndpoint('https://a.example.dev'), 'https://a.example.dev/basket/insight');
  assert.equal(insightEndpoint('https://a.example.dev/'), 'https://a.example.dev/basket/insight');
  assert.equal(insightEndpoint('https://a.example.dev/basket/insight'), 'https://a.example.dev/basket/insight');
  assert.equal(insightEndpoint('http://localhost:8787'), 'http://localhost:8787/basket/insight');
  assert.equal(insightEndpoint('http://a.example.dev'), null); // https 以外は使わない
  assert.equal(insightEndpoint('abc'), null);
  assert.equal(insightEndpoint(''), null);
});

test('未設定・URL不正・オフラインは通信せずに理由を返す', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; return response(200, {}); };
  assert.deepEqual(await requestInsights({}, {}, { fetchImpl }), { ok: false, reason: 'not_configured' });
  assert.deepEqual(await requestInsights({ workerUrl: 'abc', staffPass: 'x' }, {}, { fetchImpl }), { ok: false, reason: 'bad_url' });
  assert.deepEqual(await requestInsights(settings, {}, { fetchImpl, online: false }), { ok: false, reason: 'offline' });
  assert.equal(called, 0);
  assert.ok(!isConfigured({ workerUrl: 'x' }));
});

test('成功：パスコードをヘッダーで送り、応答の JSON を返す', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return response(200, { insights: [{ candidateId: 'c1', line: 'x' }] });
  };
  const r = await requestInsights(settings, { kind: 'quarter_insight' }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.insights, [{ candidateId: 'c1', line: 'x' }]);
  assert.equal(seen.url, 'https://relay.example.workers.dev/basket/insight');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['X-Staff-Pass'], 'pass');
  assert.deepEqual(JSON.parse(seen.init.body), { kind: 'quarter_insight' });
});

test('401・403・502 は理由を分ける', async () => {
  assert.equal((await requestInsights(settings, {}, { fetchImpl: async () => response(401, {}) })).reason, 'unauthorized');
  assert.equal((await requestInsights(settings, {}, { fetchImpl: async () => response(403, {}) })).reason, 'forbidden');
  const r = await requestInsights(settings, {}, { fetchImpl: async () => response(502, {}) });
  assert.deepEqual(r, { ok: false, reason: 'http', status: 502 });
  assert.equal(reasonText(r), 'AIの中継でエラーが起きました（502）');
});

test('応答が JSON でなければ bad_response、通信エラーは network', async () => {
  assert.equal((await requestInsights(settings, {}, { fetchImpl: async () => response(200, 'not json') })).reason, 'bad_response');
  assert.equal((await requestInsights(settings, {}, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } })).reason, 'network');
});

test('決めた時間で応答がなければ timeout（中断する）', async () => {
  let aborted = false;
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
  const start = Date.now();
  const r = await requestInsights(settings, {}, { fetchImpl, timeoutMs: 50 });
  assert.deepEqual(r, { ok: false, reason: 'timeout' });
  assert.ok(aborted);
  assert.ok(Date.now() - start < 1000);
  assert.equal(reasonText(r), '10秒で応答がありません');
});

test('接続テストは候補0件で送る', async () => {
  let body;
  const r = await testConnection(settings, { fetchImpl: async (u, init) => { body = JSON.parse(init.body); return response(200, { insights: [] }); } });
  assert.equal(r.ok, true);
  assert.deepEqual(body.candidates, []);
  assert.equal(body.kind, 'quarter_insight');
});
