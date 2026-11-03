import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleInsight, parseModelOutput, filterInsights, sanitizeCandidates, buildRequestBody, buildUserPayload,
  safeEqual, allowedOrigins, SYSTEM_PROMPT, DEFAULT_MODEL, ANTHROPIC_URL,
} from '../worker/insight.js';
import worker from '../worker/index.js';

const ORIGIN = 'https://goldfish0824-web.github.io';
const env = { STAFF_PASS: 'secret-pass', ANTHROPIC_API_KEY: 'test-key' };

const payload = {
  kind: 'quarter_insight',
  quarterEnded: 2,
  isHalftime: true,
  score: { us: 28, opp: 31, byQuarter: { us: [15, 13], opp: [14, 17] } },
  candidates: [
    { id: 'c1', category: 'opp_hot', subject: '相手#7', situation: '右ドライブ', made: 4, att: 5, scope: '前半', localScore: 0.82, name: 'ハナコ' },
    { id: 'c2', category: 'us_defense_eff', subject: '自チーム', situation: '対2-3ゾーンの3P', made: 1, att: 8, scope: '前半', localScore: 0.74 },
  ],
};

function req(body, { method = 'POST', pass = 'secret-pass', origin = ORIGIN, path = '/basket/insight' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (pass != null) headers['X-Staff-Pass'] = pass;
  if (origin) headers.Origin = origin;
  return new Request(`https://relay.example.workers.dev${path}`, {
    method,
    headers,
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
}

function anthropicReply(text, extra = {}) {
  return async () => new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }],
    ...extra,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('CORS：許可した origin のプリフライトに答える', async () => {
  const res = await handleInsight(req(null, { method: 'OPTIONS' }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /X-Staff-Pass/);
});

test('CORS：ほかの origin は 403', async () => {
  const res = await handleInsight(req(payload, { origin: 'https://evil.example.com' }), env);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

test('許可する origin は ALLOWED_ORIGINS で変えられる', () => {
  assert.deepEqual(allowedOrigins({}), [ORIGIN]);
  assert.deepEqual(allowedOrigins({ ALLOWED_ORIGINS: 'https://a.example, http://localhost:8000/' }), ['https://a.example', 'http://localhost:8000']);
});

test('パスコードが違う・ない・Worker に未設定なら 401', async () => {
  assert.equal((await handleInsight(req(payload, { pass: 'wrong' }), env)).status, 401);
  assert.equal((await handleInsight(req(payload, { pass: null }), env)).status, 401);
  assert.equal((await handleInsight(req(payload), { ANTHROPIC_API_KEY: 'k' })).status, 401);
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'abcd'));
});

test('形の違うリクエストは 400、POST 以外は 405', async () => {
  assert.equal((await handleInsight(req('not json'), env)).status, 400);
  assert.equal((await handleInsight(req({ kind: 'other', candidates: [] }), env)).status, 400);
  assert.equal((await handleInsight(req(null, { method: 'GET' }), env)).status, 405);
});

test('候補0件なら AI を呼ばずに空を返す（接続テスト）', async () => {
  let called = false;
  const res = await handleInsight(req({ ...payload, candidates: [] }), env, { fetchImpl: async () => { called = true; } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { insights: [] });
  assert.equal(called, false);
});

test('Messages API を呼んで、候補にある ID の行だけ返す', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return anthropicReply(JSON.stringify({
      insights: [
        { candidateId: 'c1', line: '相手#7、右ドライブで5本中4本成功' },
        { candidateId: 'c99', line: '候補にない' },
        { candidateId: 'c2', line: '自チーム、対2-3ゾーンの3Pは8本中1本' },
      ],
    }))();
  };
  const res = await handleInsight(req(payload), env, { fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.deepEqual(await res.json(), {
    insights: [
      { candidateId: 'c1', line: '相手#7、右ドライブで5本中4本成功' },
      { candidateId: 'c2', line: '自チーム、対2-3ゾーンの3Pは8本中1本' },
    ],
  });
  assert.equal(sent.url, ANTHROPIC_URL);
  assert.equal(sent.init.headers['x-api-key'], 'test-key');
  assert.ok(sent.init.headers['anthropic-version']);
  assert.equal(sent.body.model, DEFAULT_MODEL);
  assert.equal(sent.body.system, SYSTEM_PROMPT);
  assert.equal(sent.body.output_config.format.type, 'json_schema');
  assert.equal('temperature' in sent.body, false);
  // 想定外の項目（名前）は AI に送らない
  const userText = sent.body.messages[0].content;
  assert.ok(!userText.includes('ハナコ'));
  assert.deepEqual(JSON.parse(userText).candidates[0], {
    id: 'c1', category: 'opp_hot', subject: '相手#7', situation: '右ドライブ', scope: '前半', made: 4, att: 5, localScore: 0.82,
  });
});

test('MODEL などは変数で変えられる', () => {
  const body = buildRequestBody({}, { MODEL: 'claude-sonnet-5-5', MAX_TOKENS: '600', EFFORT: 'medium' });
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.max_tokens, 600);
  assert.equal(body.output_config.effort, 'medium');
  assert.equal(buildRequestBody({}, {}).model, 'claude-haiku-5-5');
});

test('AI の出力を読めなければ 502', async () => {
  assert.equal((await handleInsight(req(payload), env, { fetchImpl: anthropicReply('ごめんなさい') })).status, 502);
  assert.equal((await handleInsight(req(payload), env, { fetchImpl: anthropicReply('{"foo":1}') })).status, 502);
  assert.equal((await handleInsight(req(payload), env, { fetchImpl: anthropicReply('{}', { stop_reason: 'refusal' }) })).status, 502);
  assert.equal((await handleInsight(req(payload), env, { fetchImpl: async () => new Response('err', { status: 529 }) })).status, 502);
  assert.equal((await handleInsight(req(payload), env, { fetchImpl: async () => { throw new Error('down'); } })).status, 502);
});

test('APIキーが未設定なら 500', async () => {
  assert.equal((await handleInsight(req(payload), { STAFF_PASS: 'secret-pass' })).status, 500);
});

test('出力の読み取り：前後に文字があっても JSON 部分を取り出す', () => {
  const data = { stop_reason: 'end_turn', content: [{ type: 'text', text: '結果です\n{"insights":[{"candidateId":"c1","line":"x"}]}\n以上' }] };
  assert.deepEqual(parseModelOutput(data), { insights: [{ candidateId: 'c1', line: 'x' }] });
  assert.equal(parseModelOutput(null), null);
  assert.equal(parseModelOutput({ content: [{ type: 'thinking', thinking: '' }] }), null);
});

test('最大3行、重複と空行は捨てる', () => {
  const r = filterInsights([
    { candidateId: 'c1', line: 'a' }, { candidateId: 'c1', line: 'b' }, { candidateId: 'c2', line: ' ' },
    { candidateId: 'c3', line: 'c' }, { candidateId: 'c4', line: 'd' }, { candidateId: 'c5', line: 'e' },
  ], ['c1', 'c2', 'c3', 'c4', 'c5']);
  assert.deepEqual(r.map((x) => x.candidateId), ['c1', 'c3', 'c4']);
});

test('候補は20件まで、決まった項目だけ', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `c${i + 1}`, made: 1, att: 'x', extra: 1 }));
  const s = sanitizeCandidates(many);
  assert.equal(s.length, 20);
  assert.deepEqual(s[0], { id: 'c1', made: 1 });
  const u = buildUserPayload({ quarterEnded: 3, isHalftime: 'yes', inProgress: true, score: { us: 1, opp: 2, byQuarter: { us: [1, 'x'] } } }, []);
  assert.deepEqual(u, { kind: 'quarter_insight', quarterEnded: 3, isHalftime: false, score: { us: 1, opp: 2, byQuarter: { us: [1], opp: [] } }, candidates: [], inProgress: true });
});

test('単独の Worker の入口：/basket/insight 以外は 404', async () => {
  assert.equal((await worker.fetch(req(null, { method: 'GET', path: '/' }), env)).status, 404);
  assert.equal((await worker.fetch(req(null, { method: 'OPTIONS' }), env)).status, 204);
});

test('システムプロンプトは SPEC 5-6 のとおり', () => {
  assert.match(SYSTEM_PROMPT, /^あなたは高校女子バスケットボール部のアナリスト補助です。/);
  assert.match(SYSTEM_PROMPT, /戦術の指示や助言は書かない。事実だけを書く。/);
  assert.match(SYSTEM_PROMPT, /出力は次のJSONのみ：\{"insights":\[\{"candidateId":"\.\.\.","line":"\.\.\."\}\]\}$/);
});
