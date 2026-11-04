// ===== Cloudflare の画面で作った Worker に、このファイルをまるごと貼って「Deploy」する =====
// （insight.js と、いちばん下の入口を1つにしたもの。自動で作っているので、直接は直さない）

// AI特筆データの中継（SPEC 5-6）。Cloudflare Worker のハンドラー関数。
// 既存の中継 Worker に組み込めるよう、外部ライブラリなしで書いている（README.md 参照）。
//
//   ルート       POST /basket/insight（ブラウザからの OPTIONS も受ける）
//                本文の kind で分ける：quarter_insight（AI特筆データ）／advice（対処の例を聞く）
//   認証         ヘッダー X-Staff-Pass ＝ シークレット STAFF_PASS（違えば 401）
//   CORS         既定は https://goldfish0824-web.github.io のみ。変数 ALLOWED_ORIGINS（カンマ区切り）で変更
//   モデル       変数 MODEL（既定 claude-haiku-5-5。品質を上げたいときは claude-sonnet-5-5）
//                対処の例だけ別のモデルにするときは変数 ADVICE_MODEL
//   APIキー      シークレット ANTHROPIC_API_KEY（リポジトリに実値を書かない）
//   応答         特筆データ {"insights":[{"candidateId":"c1","line":"…"}]}
//                対処の例   {"options":[{"label":"…","detail":"…"}],"related":["press-221"]}
//                AI の出力を読めなければ 502

export const SYSTEM_PROMPT = `あなたは高校女子バスケットボール部のアナリスト補助です。
クォーター終了時またはハーフタイムに、ベンチのスタッフがコーチへ伝える「特筆すべきデータ」を選びます。

ルール：
- 入力の candidates の中からだけ選ぶ。候補にない数字を作ったり、計算し直したりしない。
- 選ぶのは最大3つ。次の展開に影響しそうなものを優先する（ファウルトラブル、相手の得点源の偏り、自チームの効率が極端に悪い／良い攻め、ターンオーバーの集中、リバウンド差など）。
- 試投数が3未満の候補は選ばない。
- 1行30字以内。「相手#7、右ドライブで5本中4本成功」のように、主語（自チーム／相手＋背番号）→状況→数字の順で書く。
- 戦術の指示や助言は書かない。事実だけを書く。「〜の可能性」「〜かもしれない」などの推測も書かない。
- ルールは FIBA。個人ファウル5つで退場（「相手#10、5ファウルで退場」のように書く）。チームファウルは5つ目から相手に2本のフリースロー。
- 出力は次のJSONのみ：{"insights":[{"candidateId":"...","line":"..."}]}`;

export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const DEFAULT_ALLOWED_ORIGINS = ['https://goldfish0824-web.github.io'];
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2026-10-21';
// Claude Haiku 5.5 は既定で考える（thinking）。その分も max_tokens に数えられるので、短い JSON でも余裕を持たせる
export const DEFAULT_MAX_TOKENS = 1000;
export const DEFAULT_EFFORT = 'low';
export const MAX_CANDIDATES = 20;
export const MAX_INSIGHTS = 3;
const UPSTREAM_TIMEOUT_MS = 9000; // アプリ側は10秒で諦めるので、それより短く

// ---- 対処の例（kind: advice） ----
export const ADVICE_SYSTEM_PROMPT = `あなたは高校女子バスケットボール部のアナリスト補助です。
試合中（クォーターの間、ハーフタイム、タイムアウト）に、ベンチのスタッフから「この数字や場面に対して、どんな対処が考えられるか」を聞かれます。
決めるのはコーチです。あなたは、コーチが選ぶための「対処の例」を出します。

入力：
- insight：アプリが計算した特筆データの1行と、その数字（candidate）。ないこともある。
- question：スタッフが入力した質問。空のこともある。
- score・quarter・defenses（直近の守備隊形。opp＝相手の守り、us＝自チームの守り）。
- qa：アプリに入っている場面別Q&A の一覧（id と title）。

ルール：
- 対処の例を2〜3個。それぞれ label（20字以内の見出し）と detail（80字以内。具体的な動きと、その数字・場面にどう効くか）。
- 入力の数字をそのまま使う。数字を作ったり、計算し直したりしない。
- 「〜すべき」「〜しなければならない」とは書かない。「〜する」「〜という手がある」のように、例として書く。
- 公立高校の女子チームが、試合中の短い時間で伝えられて、すぐ使える内容にする。
- ルールは FIBA（個人ファウル5つで退場、チームファウル5つ目から2本のフリースロー、タイムアウトは前半2回・後半3回など）。
- 「ターンオーバー」「タイムアウト」は略さない（「TO」と書かない）。
- 選手を責める言い方や、けがにつながるプレーは書かない。
- related には、qa の一覧から関係の深いものの id を最大2つ入れる（なければ空の配列）。
- 質問がバスケットボールの試合と関係ないときは、options を空の配列にする。
- 出力は次のJSONのみ：{"options":[{"label":"...","detail":"..."}],"related":["..."]}`;

export const DEFAULT_ADVICE_MAX_TOKENS = 2000;
export const MAX_ADVICE_OPTIONS = 3;
export const MAX_ADVICE_RELATED = 2;
export const MAX_QUESTION_LENGTH = 200;
const ADVICE_UPSTREAM_TIMEOUT_MS = 18000; // アプリ側は20秒で諦める

const ADVICE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['label', 'detail'],
        additionalProperties: false,
      },
    },
    related: { type: 'array', items: { type: 'string' } },
  },
  required: ['options', 'related'],
  additionalProperties: false,
};

// 応答の形を固定する（structured outputs）
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    insights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidateId: { type: 'string' },
          line: { type: 'string' },
        },
        required: ['candidateId', 'line'],
        additionalProperties: false,
      },
    },
  },
  required: ['insights'],
  additionalProperties: false,
};

const CANDIDATE_FIELDS = {
  id: 'string',
  category: 'string',
  subject: 'string',
  situation: 'string',
  scope: 'string',
  made: 'number',
  att: 'number',
  value: 'number',
  total: 'number',
  us: 'number',
  opp: 'number',
  localScore: 'number',
};

export function allowedOrigins(env = {}) {
  const raw = env.ALLOWED_ORIGINS;
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  return String(raw)
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function corsHeaders(origin, env) {
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Staff-Pass',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/** 長さに関係なく同じ時間で比べる（パスコードの照合） */
export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

/** 候補を決まった項目だけにする（名前など想定外の項目は送らない） */
export function sanitizeCandidates(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list.slice(0, MAX_CANDIDATES)) {
    if (!c || typeof c.id !== 'string' || !c.id) continue;
    const clean = {};
    for (const [k, type] of Object.entries(CANDIDATE_FIELDS)) {
      const v = c[k];
      if (type === 'string' && typeof v === 'string') clean[k] = v.slice(0, 60);
      if (type === 'number' && typeof v === 'number' && Number.isFinite(v)) clean[k] = v;
    }
    out.push(clean);
  }
  return out;
}

function numberList(v) {
  return Array.isArray(v) ? v.filter((n) => typeof n === 'number' && Number.isFinite(n)).slice(0, 10) : [];
}

/** モデルに渡す入力（SPEC 5-5 の形） */
export function buildUserPayload(payload, candidates) {
  const score = payload.score || {};
  const byQ = score.byQuarter || {};
  const out = {
    kind: 'quarter_insight',
    quarterEnded: Number(payload.quarterEnded) || 0,
    isHalftime: payload.isHalftime === true,
    score: {
      us: Number(score.us) || 0,
      opp: Number(score.opp) || 0,
      byQuarter: { us: numberList(byQ.us), opp: numberList(byQ.opp) },
    },
    candidates,
  };
  if (payload.inProgress === true) out.inProgress = true;
  return out;
}

export function buildRequestBody(userPayload, env = {}) {
  return {
    model: env.MODEL || DEFAULT_MODEL,
    max_tokens: Number(env.MAX_TOKENS) || DEFAULT_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: env.EFFORT || DEFAULT_EFFORT,
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
  };
}

/** Messages API の応答の文字（JSON）をオブジェクトにする。読めなければ null */
export function parseJsonOutput(data) {
  if (!data || data.stop_reason === 'refusal' || !Array.isArray(data.content)) return null;
  // 先頭に thinking ブロックが来ることがあるので、種類で text だけを集める
  const text = data.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) return null;
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        obj = JSON.parse(text.slice(start, end + 1));
      } catch {
        obj = null;
      }
    }
  }
  return obj && typeof obj === 'object' ? obj : null;
}

/** Messages API の応答から {insights:[…]} を取り出す。読めなければ null */
export function parseModelOutput(data) {
  const obj = parseJsonOutput(data);
  return obj && Array.isArray(obj.insights) ? obj : null;
}

/** 候補にない ID・重複・空行を捨て、最大3つにする */
export function filterInsights(insights, candidateIds) {
  const ids = new Set(candidateIds);
  const used = new Set();
  const out = [];
  for (const it of insights || []) {
    if (!it || typeof it.candidateId !== 'string' || typeof it.line !== 'string') continue;
    const line = it.line.trim().slice(0, 80);
    if (!ids.has(it.candidateId) || used.has(it.candidateId) || !line) continue;
    used.add(it.candidateId);
    out.push({ candidateId: it.candidateId, line });
    if (out.length >= MAX_INSIGHTS) break;
  }
  return out;
}

// ---- 対処の例 ----

function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** 対処の例の入力を、決まった項目だけにする。insight も question もなければ null */
export function sanitizeAdvicePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const question = cleanText(payload.question, MAX_QUESTION_LENGTH);
  let insight = null;
  if (payload.insight && typeof payload.insight === 'object') {
    const [candidate] = sanitizeCandidates([{ id: 'c0', ...(payload.insight.candidate || {}) }]);
    const line = cleanText(payload.insight.line, 80);
    if (line) insight = { line, candidate: candidate || {} };
  }
  if (!question && !insight) return null;
  const score = payload.score || {};
  const byQ = score.byQuarter || {};
  const defenses = payload.defenses || {};
  const qa = [];
  for (const x of Array.isArray(payload.qa) ? payload.qa.slice(0, 80) : []) {
    const id = cleanText(x && x.id, 40);
    const title = cleanText(x && x.title, 80);
    if (id && title) qa.push({ id, title });
  }
  const out = {
    kind: 'advice',
    quarter: Number(payload.quarter) || 0,
    isHalftime: payload.isHalftime === true,
    inProgress: payload.inProgress === true,
    score: {
      us: Number(score.us) || 0,
      opp: Number(score.opp) || 0,
      byQuarter: { us: numberList(byQ.us), opp: numberList(byQ.opp) },
    },
    defenses: { opp: cleanText(defenses.opp, 30) || null, us: cleanText(defenses.us, 30) || null },
    question,
    qa,
  };
  if (insight) out.insight = insight;
  return out;
}

export function buildAdviceRequestBody(advicePayload, env = {}) {
  return {
    model: env.ADVICE_MODEL || env.MODEL || DEFAULT_MODEL,
    max_tokens: Number(env.ADVICE_MAX_TOKENS) || DEFAULT_ADVICE_MAX_TOKENS,
    system: ADVICE_SYSTEM_PROMPT,
    output_config: {
      effort: env.EFFORT || DEFAULT_EFFORT,
      format: { type: 'json_schema', schema: ADVICE_OUTPUT_SCHEMA },
    },
    messages: [{ role: 'user', content: JSON.stringify(advicePayload) }],
  };
}

/** 見出しと説明のそろったものを最大3つ、関連は一覧にある id だけ最大2つ */
export function filterAdvice(obj, qaIds) {
  const options = [];
  for (const o of Array.isArray(obj && obj.options) ? obj.options : []) {
    const label = cleanText(o && o.label, 40);
    const detail = cleanText(o && o.detail, 200);
    if (!label || !detail) continue;
    options.push({ label, detail });
    if (options.length >= MAX_ADVICE_OPTIONS) break;
  }
  const known = new Set(qaIds);
  const related = [];
  for (const id of Array.isArray(obj && obj.related) ? obj.related : []) {
    if (typeof id === 'string' && known.has(id) && !related.includes(id)) related.push(id);
    if (related.length >= MAX_ADVICE_RELATED) break;
  }
  return { options, related };
}

/** Claude に問い合わせて JSON を返す。だめなら { error, status? } */
async function callClaude(body, env, fetchImpl, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { error: 'upstream_unreachable' };
  }
  if (!res.ok) return { error: 'upstream_error', status: res.status };
  try {
    return { data: await res.json() };
  } catch {
    return { data: null };
  }
}

/**
 * POST /basket/insight のハンドラー。
 * 既存の Worker の fetch から `return handleInsight(request, env);` で呼ぶ。
 * opts.fetchImpl はテスト用（既定は fetch）。
 */
export async function handleInsight(request, env = {}, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env);
  if (origin && !cors['Access-Control-Allow-Origin']) return json({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

  const pass = request.headers.get('X-Staff-Pass') || '';
  if (!env.STAFF_PASS || !safeEqual(pass, env.STAFF_PASS)) return json({ error: 'unauthorized' }, 401, cors);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400, cors);
  }
  if (payload && payload.kind === 'advice') {
    const advice = sanitizeAdvicePayload(payload);
    if (!advice) return json({ error: 'bad_request' }, 400, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'not_configured' }, 500, cors);
    const r = await callClaude(buildAdviceRequestBody(advice, env), env, fetchImpl, ADVICE_UPSTREAM_TIMEOUT_MS);
    if (r.error) return json(r.status ? { error: r.error, status: r.status } : { error: r.error }, 502, cors);
    const obj = parseJsonOutput(r.data);
    if (!obj || !Array.isArray(obj.options)) return json({ error: 'bad_ai_response' }, 502, cors);
    return json(filterAdvice(obj, advice.qa.map((x) => x.id)), 200, cors);
  }
  if (!payload || payload.kind !== 'quarter_insight' || !Array.isArray(payload.candidates)) {
    return json({ error: 'bad_request' }, 400, cors);
  }

  const candidates = sanitizeCandidates(payload.candidates);
  // 候補が0件なら AI を呼ばない（アプリの「接続テスト」もこれを使う）
  if (candidates.length === 0) return json({ insights: [] }, 200, cors);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'not_configured' }, 500, cors);

  const body = buildRequestBody(buildUserPayload(payload, candidates), env);
  const r = await callClaude(body, env, fetchImpl, UPSTREAM_TIMEOUT_MS);
  if (r.error) return json(r.status ? { error: r.error, status: r.status } : { error: r.error }, 502, cors);
  const parsed = parseModelOutput(r.data);
  if (!parsed) return json({ error: 'bad_ai_response' }, 502, cors);
  return json({ insights: filterInsights(parsed.insights, candidates.map((c) => c.id)) }, 200, cors);
}

// ===== 入口：/basket/insight だけを受ける =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/basket/insight') return handleInsight(request, env);
    return new Response('Not found', { status: 404 });
  },
};
