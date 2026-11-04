import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleInsight, parseModelOutput, filterInsights, sanitizeCandidates, buildRequestBody, buildUserPayload,
  safeEqual, allowedOrigins, SYSTEM_PROMPT, DEFAULT_MODEL, ANTHROPIC_URL,
  ADVICE_SYSTEM_PROMPT, sanitizeAdvicePayload, buildAdviceRequestBody, filterAdvice,
  REPORT_SYSTEM_PROMPT, sanitizeReportPayload, buildReportRequestBody, filterReport, cleanReportValue, DEFAULT_REPORT_MODEL,
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

// ---- 対処の例（kind: advice） ----

const advicePayload = {
  kind: 'advice',
  quarter: 2,
  isHalftime: true,
  inProgress: false,
  score: { us: 28, opp: 31, byQuarter: { us: [15, 13], opp: [14, 17] } },
  defenses: { opp: '2-2-1プレス', us: 'マンツー' },
  insight: {
    line: '自チーム、後半ターンオーバー4本（プレス5回中）',
    candidate: { id: 'c2', category: 'turnovers', subject: '自チーム', situation: 'ターンオーバー（2-2-1プレス）', made: 4, att: 5, scope: '後半', name: 'ハナコ' },
  },
  question: '  どう運べばいい？\n',
  qa: [{ id: 'press-221', title: '2-2-1オールコートゾーンプレスに対する攻め方' }, { id: 'press-turnovers', title: 'プレスでターンオーバーが続く' }],
};

test('対処の例：AI に渡すのは決まった項目だけ。答えは例を最大3つ・一覧にある Q&A だけ', async () => {
  let sent = null;
  const reply = JSON.stringify({
    options: [
      { label: '中央に1人入れる', detail: 'ハーフライン手前の中央で受けて前を向く。' },
      { label: '逆サイドへ戻す', detail: 'スローインした4が後ろに立ち、逆サイドへ。' },
      { label: '  ', detail: '見出しがないので捨てる' },
      { label: '4つ目', detail: '数が多いので捨てる' },
      { label: '5つ目', detail: '数が多いので捨てる' },
    ],
    related: ['press-221', 'no-such-id', 'press-221', 'press-turnovers'],
  });
  const fetchImpl = async (url, init) => {
    sent = { url, body: JSON.parse(init.body), headers: init.headers };
    return anthropicReply(reply)();
  };
  const res = await handleInsight(req(advicePayload), { ...env, ADVICE_MODEL: 'claude-sonnet-5-5' }, { fetchImpl });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.options.length, 3);
  assert.deepEqual(body.options[0], { label: '中央に1人入れる', detail: 'ハーフライン手前の中央で受けて前を向く。' });
  assert.deepEqual(body.related, ['press-221', 'press-turnovers']);
  // 送った内容
  assert.equal(sent.url, ANTHROPIC_URL);
  assert.equal(sent.body.model, 'claude-sonnet-5-5');
  assert.equal(sent.body.system, ADVICE_SYSTEM_PROMPT);
  assert.equal(sent.body.output_config.format.type, 'json_schema');
  const user = JSON.parse(sent.body.messages[0].content);
  assert.equal(user.question, 'どう運べばいい？');
  assert.equal(user.insight.candidate.name, undefined, '名前は送らない');
  assert.equal(user.insight.candidate.att, 5);
  assert.deepEqual(user.defenses, { opp: '2-2-1プレス', us: 'マンツー' });
  assert.equal(user.qa.length, 2);
});

test('対処の例：特筆データも質問もなければ 400。AI は呼ばない', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return anthropicReply('{}')();
  };
  const res = await handleInsight(req({ ...advicePayload, insight: null, question: '   ' }), env, { fetchImpl });
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test('対処の例：パスコードが違えば 401、AI の出力が読めなければ 502', async () => {
  assert.equal((await handleInsight(req(advicePayload, { pass: 'wrong' }), env)).status, 401);
  const bad = await handleInsight(req(advicePayload), env, { fetchImpl: anthropicReply('対処の例です') });
  assert.equal(bad.status, 502);
  const refused = await handleInsight(req(advicePayload), env, { fetchImpl: anthropicReply('{}', { stop_reason: 'refusal' }) });
  assert.equal(refused.status, 502);
});

test('対処の例：モデルは ADVICE_MODEL → MODEL → 既定の順', () => {
  const p = sanitizeAdvicePayload(advicePayload);
  assert.equal(buildAdviceRequestBody(p, {}).model, DEFAULT_MODEL);
  assert.equal(buildAdviceRequestBody(p, { MODEL: 'm1' }).model, 'm1');
  assert.equal(buildAdviceRequestBody(p, { MODEL: 'm1', ADVICE_MODEL: 'm2' }).model, 'm2');
  // 質問は200字まで
  assert.equal(sanitizeAdvicePayload({ ...advicePayload, question: 'あ'.repeat(500) }).question.length, 200);
  assert.deepEqual(filterAdvice({ options: 'x', related: null }, []), { options: [], related: [] });
});

test('AI への指示：事実だけ・推測しない・5ファウルは退場（特筆データ）。対処の例は「〜すべき」と書かない・判断はコーチ', () => {
  assert.match(SYSTEM_PROMPT, /推測/);
  assert.match(SYSTEM_PROMPT, /5つで退場/);
  assert.match(ADVICE_SYSTEM_PROMPT, /〜すべき/);
  assert.match(ADVICE_SYSTEM_PROMPT, /決めるのはコーチ/);
  assert.match(ADVICE_SYSTEM_PROMPT, /TO/);
  assert.ok(!/顧問/.test(SYSTEM_PROMPT + ADVICE_SYSTEM_PROMPT));
});

test('Cloudflare の画面に貼る1ファイル版（dashboard.js）は insight.js と同じ中身', async () => {
  const { readFileSync } = await import('node:fs');
  const { makeDashboard } = await import('../worker/make-dashboard.mjs');
  const src = readFileSync(new URL('../worker/insight.js', import.meta.url), 'utf8');
  const dash = readFileSync(new URL('../worker/dashboard.js', import.meta.url), 'utf8');
  assert.equal(dash, makeDashboard(src), 'insight.js を変えたら node worker/make-dashboard.mjs で作り直す');
  // 1ファイルで動く：入口から特筆データと対処の例の両方を受ける
  const mod = await import('../worker/dashboard.js');
  const res = await mod.default.fetch(req({ ...payload, candidates: [] }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { insights: [] });
  assert.equal((await mod.default.fetch(req(payload, { path: '/other' }), env)).status, 404);
});

// ---- AIふりかえり（kind: game_report） ----

const reportPayload = {
  kind: 'game_report',
  score: { us: 38, opp: 42, byQuarter: { us: [11, 7, 7, 13], opp: [11, 16, 6, 9] } },
  us: { pts: 38, fg: [15, 40], tp: [2, 10], ft: [6, 10], or: 8, dr: 20, to: 14, pf: 12 },
  players: [{ no: '#4', pts: 10, fg: [4, 6], name: 'ハナコ' }],
  coachNote: 'あ'.repeat(600),
  'bad key': 'x',
  deep: { a: { b: { c: { d: { e: 1 } } } } },
};

test('ふりかえり：既定は Sonnet。断られたときの server-side fallback を付ける。名前などは捨てる', async () => {
  let sent = null;
  const reply = JSON.stringify({
    summary: '後半にターンオーバーが増えた。',
    good: [{ point: 'ゴール下', evidence: '7本中6本' }],
    issues: [{ point: 'ターンオーバー', evidence: '14本' }],
    practice: [{ issue: 'ターンオーバー', menu: 'プレス突破', detail: '中央で受ける。', minutes: 15 }],
    watch: ['ターンオーバーの数'],
  });
  const fetchImpl = async (url, init) => {
    sent = { body: JSON.parse(init.body), headers: init.headers };
    return anthropicReply(reply)();
  };
  const res = await handleInsight(req(reportPayload), env, { fetchImpl });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.good[0].point, 'ゴール下');
  assert.equal(body.practice[0].minutes, 15);
  assert.equal(sent.body.model, 'claude-sonnet-5-5');
  assert.equal(sent.body.system, REPORT_SYSTEM_PROMPT);
  assert.equal(sent.body.fallbacks, 'default');
  assert.equal(sent.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(sent.body.output_config.effort, 'medium');
  const user = JSON.parse(sent.body.messages[0].content);
  assert.equal(user.players[0].name, undefined, '名前は捨てる');
  assert.equal(user.players[0].pts, 10);
  assert.equal(user.coachNote.length, 400);
  assert.equal(user['bad key'], undefined);
  assert.equal(user.kind, undefined);
});

test('ふりかえり：Haiku など fallback のないモデルには付けない。REPORT_MODEL で変えられる', () => {
  const p = sanitizeReportPayload(reportPayload);
  const haiku = buildReportRequestBody(p, { REPORT_MODEL: 'claude-haiku-5-5' });
  assert.equal(haiku.model, 'claude-haiku-5-5');
  assert.equal(haiku.fallbacks, undefined);
  assert.equal(buildReportRequestBody(p, {}).model, DEFAULT_REPORT_MODEL);
  // 試合中の2つは Haiku のまま
  assert.equal(DEFAULT_MODEL, 'claude-haiku-5-5');
});

test('ふりかえり：得点がなければ 400（AI は呼ばない）。読めない応答は 502', async () => {
  let called = false;
  const res = await handleInsight(req({ kind: 'game_report', score: { us: 0, opp: 0 } }), env, { fetchImpl: async () => { called = true; return anthropicReply('{}')(); } });
  assert.equal(res.status, 400);
  assert.equal(called, false);
  const bad = await handleInsight(req(reportPayload), env, { fetchImpl: anthropicReply(JSON.stringify({ summary: 'x', good: [], issues: [], practice: [], watch: [] })) });
  assert.equal(bad.status, 502);
  assert.deepEqual(filterReport(null), null);
});

test('ふりかえりの入力の写し方：キーは英数字、文字は120字（メモは400字）、配列は40件、深さは4まで', () => {
  const v = cleanReportValue({ a: 'x'.repeat(500), list: Array.from({ length: 60 }, (_, i) => i), 'ﾀﾞﾒ': 1, deep: { a: { b: { c: { d: 1 } } } }, n: Infinity });
  assert.equal(v.a.length, 120);
  assert.equal(v.list.length, 40);
  assert.equal(v['ﾀﾞﾒ'], undefined);
  assert.deepEqual(v.deep, { a: { b: {} } });
  assert.equal(v.n, undefined);
});

test('AI への指示（ふりかえり）：「〜すべき」と書かない・判断はコーチ・名前を書かない・数字を作らない', () => {
  assert.match(REPORT_SYSTEM_PROMPT, /〜すべき/);
  assert.match(REPORT_SYSTEM_PROMPT, /決めるのはコーチ/);
  assert.match(REPORT_SYSTEM_PROMPT, /名前は書かない/);
  assert.match(REPORT_SYSTEM_PROMPT, /作ったり、計算し直したりしない/);
  assert.ok(!/顧問/.test(REPORT_SYSTEM_PROMPT));
});
