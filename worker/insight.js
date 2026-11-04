// AI特筆データの中継（SPEC 5-6）。Cloudflare Worker のハンドラー関数。
// 既存の中継 Worker に組み込めるよう、外部ライブラリなしで書いている（README.md 参照）。
//
//   ルート       POST /basket/insight（ブラウザからの OPTIONS も受ける）
//   認証         ヘッダー X-Staff-Pass ＝ シークレット STAFF_PASS（違えば 401）
//   CORS         既定は https://goldfish0824-web.github.io のみ。変数 ALLOWED_ORIGINS（カンマ区切り）で変更
//   モデル       変数 MODEL（既定 claude-haiku-5-5。品質を上げたいときは claude-sonnet-5-5）
//   APIキー      シークレット ANTHROPIC_API_KEY（リポジトリに実値を書かない）
//   応答         {"insights":[{"candidateId":"c1","line":"…"}]}。AI の出力を読めなければ 502

export const SYSTEM_PROMPT = `あなたは高校女子バスケットボール部のアナリスト補助です。
クォーター終了時またはハーフタイムに、ベンチのスタッフがコーチへ伝える「特筆すべきデータ」を選びます。

ルール：
- 入力の candidates の中からだけ選ぶ。候補にない数字を作ったり、計算し直したりしない。
- 選ぶのは最大3つ。次の展開に影響しそうなものを優先する（ファウルトラブル、相手の得点源の偏り、自チームの効率が極端に悪い／良い攻め、ターンオーバーの集中、リバウンド差など）。
- 試投数が3未満の候補は選ばない。
- 1行30字以内。「相手#7、右ドライブで5本中4本成功」のように、主語（自チーム／相手＋背番号）→状況→数字の順で書く。
- 戦術の指示や助言は書かない。事実だけを書く。
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

/** Messages API の応答から {insights:[…]} を取り出す。読めなければ null */
export function parseModelOutput(data) {
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
  if (!obj || !Array.isArray(obj.insights)) return null;
  return obj;
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
  if (!payload || payload.kind !== 'quarter_insight' || !Array.isArray(payload.candidates)) {
    return json({ error: 'bad_request' }, 400, cors);
  }

  const candidates = sanitizeCandidates(payload.candidates);
  // 候補が0件なら AI を呼ばない（アプリの「接続テスト」もこれを使う）
  if (candidates.length === 0) return json({ insights: [] }, 200, cors);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'not_configured' }, 500, cors);

  const body = buildRequestBody(buildUserPayload(payload, candidates), env);
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
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return json({ error: 'upstream_unreachable' }, 502, cors);
  }
  if (!res.ok) return json({ error: 'upstream_error', status: res.status }, 502, cors);

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const parsed = parseModelOutput(data);
  if (!parsed) return json({ error: 'bad_ai_response' }, 502, cors);
  return json({ insights: filterInsights(parsed.insights, candidates.map((c) => c.id)) }, 200, cors);
}
