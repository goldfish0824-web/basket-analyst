// ===== Cloudflare の画面で作った Worker に、このファイルをまるごと貼って「Deploy」する =====
// （auth.js・insight.js・sync.js と、いちばん下の入口を1つにしたもの。自動で作っているので、直接は直さない）

// ----- auth.js -----
// ログイン（スタッフのアカウント）とデータベース（Cloudflare D1）の準備。外部ライブラリなし。
// D1 は Worker の「バインディング」で DB という名前でつなぐ（worker/README.md 参照）。
//
//   パスワード   PBKDF2-SHA256（ランダムな塩つき）。回数は変数 PBKDF2_ITERATIONS（既定 10000。
//                無料プランは1回の呼び出しの CPU 時間が短いため。有料プランなら増やせる）
//   ログイン     成功すると「ログインの鍵」（ランダムな文字列）を返す。データベースにはそのハッシュだけを置く。
//                180日で切れる。同じ ID で10分に5回まちがえると、15分ログインできない
//   役割         admin（管理者：アカウントを作れる）／staff（スタッフ）／student（生徒：今後。今は同期できない）

export const DEFAULT_PBKDF2_ITERATIONS = 10000;
export const SESSION_DAYS = 180;
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 10 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;
export const ROLES = ['admin', 'staff', 'student'];

export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  player_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS login_failures (
  login_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  rev INTEGER NOT NULL,
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS games_rev ON games(rev);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  rev INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_rev ON events(rev);
CREATE INDEX IF NOT EXISTS events_game ON events(game_id);
CREATE TABLE IF NOT EXISTS team (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  rev INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS team_rev ON team(rev);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('rev', 0);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', 1);`;

// ---- 文字列・暗号の小道具 ----

/** 長さに関係なく同じ時間で比べる（パスコードの照合） */
export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function toB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomId(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a);
}

/** ログインの鍵（推測できない長い文字列） */
export function newToken() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return toB64(a).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return toHex(new Uint8Array(d));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export function iterationsFor(env = {}) {
  const n = Number(env.PBKDF2_ITERATIONS);
  return Number.isInteger(n) && n >= 1000 && n <= 600000 ? n : DEFAULT_PBKDF2_ITERATIONS;
}

/** 「pbkdf2$sha256$回数$塩$ハッシュ」の形で返す */
export async function hashPassword(password, iterations = DEFAULT_PBKDF2_ITERATIONS) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const hash = await pbkdf2(password, fromB64(parts[3]), iterations);
  return safeEqual(toB64(hash), parts[4]);
}

// ---- 入力の検査 ----

/** ID：英小文字・数字・「. _ -」で3〜32字 */
export function normalizeLoginId(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[a-z0-9._-]{3,32}$/.test(s) ? s : null;
}

/** パスワード：8〜72字 */
export function validPassword(v) {
  return typeof v === 'string' && v.length >= 8 && v.length <= 72;
}

export function cleanName(v) {
  const s = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  return s || null;
}

// ---- データベース ----

/** D1 の exec は改行ごとに1文なので、1文を1行にまとめる */
export function schemaLines(sql = SCHEMA_SQL) {
  return sql.split(/;\s*\n/)
    .map((x) => x.replace(/\s*\n\s*/g, ' ').replace(/;\s*$/, '').trim())
    .filter(Boolean)
    .map((x) => `${x};`)
    .join('\n');
}

const schemaReady = new WeakSet();

/** 表がなければ作る（Worker が起動して最初の1回だけ確かめる） */
export async function ensureSchema(db) {
  if (schemaReady.has(db)) return;
  try {
    await db.prepare("SELECT value FROM meta WHERE key = 'schema'").first();
  } catch {
    await db.exec(schemaLines());
  }
  schemaReady.add(db);
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    loginId: row.login_id,
    displayName: row.display_name,
    role: row.role,
    disabled: !!row.disabled,
    playerKey: row.player_key || null,
    createdAt: row.created_at,
  };
}

export async function createSession(db, userId, device, now = Date.now()) {
  const token = newToken();
  await db.prepare('INSERT INTO sessions (token_hash, user_id, device, created_at, expires_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?4)')
    .bind(await sha256Hex(token), userId, String(device || '').slice(0, 60), now, now + SESSION_DAYS * 24 * 3600 * 1000)
    .run();
  return token;
}

/** 「Authorization: Bearer 鍵」からログイン中のユーザーを探す。なければ null */
export async function userFromRequest(request, env, now = Date.now()) {
  if (!env || !env.DB) return null;
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  await ensureSchema(env.DB);
  const row = await env.DB.prepare(
    'SELECT u.*, s.token_hash AS token_hash, s.expires_at AS expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1',
  ).bind(await sha256Hex(m[1])).first();
  if (!row || row.disabled || row.expires_at < now) return null;
  return { ...publicUser(row), tokenHash: row.token_hash };
}

/** AI の問い合わせを使えるか：スタッフ用パスコード、またはスタッフ・管理者のログイン */
export async function isStaffRequest(request, env) {
  const pass = request.headers.get('X-Staff-Pass') || '';
  if (pass && env.STAFF_PASS && safeEqual(pass, env.STAFF_PASS)) return true;
  const user = await userFromRequest(request, env);
  return !!user && (user.role === 'admin' || user.role === 'staff');
}

/** ログインの失敗を数える。ロック中なら true */
export async function isLocked(db, loginId, now = Date.now()) {
  const row = await db.prepare('SELECT locked_until FROM login_failures WHERE login_id = ?1').bind(loginId).first();
  return !!row && row.locked_until > now;
}

export async function recordFailure(db, loginId, now = Date.now()) {
  const row = await db.prepare('SELECT count, first_at FROM login_failures WHERE login_id = ?1').bind(loginId).first();
  const fresh = !row || now - row.first_at > FAILURE_WINDOW_MS;
  const count = fresh ? 1 : row.count + 1;
  const firstAt = fresh ? now : row.first_at;
  const lockedUntil = count >= MAX_FAILURES ? now + LOCK_MS : 0;
  await db.prepare(
    'INSERT INTO login_failures (login_id, count, first_at, locked_until) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(login_id) DO UPDATE SET count = ?2, first_at = ?3, locked_until = ?4',
  ).bind(loginId, lockedUntil ? 0 : count, firstAt, lockedUntil).run();
}

export async function clearFailures(db, loginId) {
  await db.prepare('DELETE FROM login_failures WHERE login_id = ?1').bind(loginId).run();
}

// ----- insight.js -----
// AI特筆データの中継（SPEC 5-6）。Cloudflare Worker のハンドラー関数。
// 既存の中継 Worker に組み込めるよう、外部ライブラリなしで書いている（README.md 参照）。
//
//   ルート       POST /basket/insight（ブラウザからの OPTIONS も受ける）
//                本文の kind で分ける：quarter_insight（AI特筆データ）／advice（対処の例を聞く）／game_report（AIふりかえり）
//   認証         ヘッダー X-Staff-Pass ＝ シークレット STAFF_PASS、またはスタッフのログイン（Authorization: Bearer。違えば 401）
//   CORS         既定は https://goldfish0824-web.github.io のみ。変数 ALLOWED_ORIGINS（カンマ区切り）で変更
//   モデル       変数 MODEL（既定 claude-haiku-5-5。品質を上げたいときは claude-sonnet-5-5）
//                対処の例だけ別のモデルにするときは変数 ADVICE_MODEL
//                AIふりかえり（試合後）は変数 REPORT_MODEL（既定 claude-sonnet-5-5。文章の質を優先）
//   APIキー      シークレット ANTHROPIC_API_KEY（リポジトリに実値を書かない）
//   応答         特筆データ {"insights":[{"candidateId":"c1","line":"…"}]}
//                対処の例   {"options":[{"label":"…","detail":"…"}],"related":["press-221"]}
//                ふりかえり {"summary":"…","good":[…],"issues":[…],"practice":[…],"watch":[…]}
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

// ---- AIふりかえり（kind: game_report。試合後） ----
export const REPORT_SYSTEM_PROMPT = `あなたは高校女子バスケットボール部のアナリスト補助です。
試合が終わったあと、アプリが計算した試合全体の数字から、コーチとチームがふりかえるための材料を作ります。決めるのはコーチです。

入力：
- score：得点（byQuarter はクォーター別。5つ目以降は延長）。us・opp：チーム合計（fg・tp・ft は [成功, 試投]、or・dr はリバウンド、to はターンオーバー、pf はファウル）。
- indicators：ppp（1回の攻撃あたりの得点）、orPct（オフェンスリバウンド率）、セカンドチャンス得点、速攻得点。
- players：自チームの背番号ごとの数字。oppScorers：相手の主な得点者。
- byDefense：自チームの攻撃を、相手の守備隊形別に。oppByDefense：相手の攻撃を、自チームの守備隊形別に。
- zones・oppZones：シュートの場所別。turnoverTags：自チームのターンオーバーの種類。
- insights：試合中にコーチへ伝えた特筆データ。checklist：チェック項目の評価（◯△×）と目標の自動判定。
- coachNote：コーチからのメモ（空のこともある）。あれば重点として扱う。

ルール：
- 数字は入力にあるものだけを使う。作ったり、計算し直したりしない。割合を書くときは「8本中3本」のように入力の数字で書く。
- 試投が3本未満の数字は根拠にしない。
- summary：試合の要点を2文以内（100字以内）。
- good：良かった点を2〜3個。point（40字以内）と、根拠の数字 evidence（40字以内）。
- issues：課題を2〜3個。point と evidence。選手を責める言い方はしない。
- practice：課題に合わせた練習の例を2〜3個。issue（どの課題か。20字以内）、menu（練習名。20字以内）、detail（やり方。100字以内）、minutes（目安の分数。5〜30）。公立高校の女子チームが、ふだんの練習時間の中で取り入れやすいものにする。
- watch：次の試合で見る数字を2〜3個（30字以内）。
- 「〜すべき」「〜しなければならない」とは書かない。「〜する」「〜という練習がある」のように、例として書く。
- ルールは FIBA（個人ファウル5つで退場、チームファウル5つ目から2本のフリースローなど）。「ターンオーバー」「タイムアウト」は略さない（「TO」と書かない）。
- 選手は背番号で書く（例：#5）。名前は書かない。
- 出力は次のJSONのみ：{"summary":"...","good":[{"point":"...","evidence":"..."}],"issues":[{"point":"...","evidence":"..."}],"practice":[{"issue":"...","menu":"...","detail":"...","minutes":15}],"watch":["..."]}`;

export const DEFAULT_REPORT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_REPORT_MAX_TOKENS = 8000;
export const DEFAULT_REPORT_EFFORT = 'medium';
const REPORT_UPSTREAM_TIMEOUT_MS = 85000; // アプリ側は90秒で諦める
// 安全のための判定で断られたとき、Anthropic が勧めるモデルで自動でやり直す（Claude API の server-side fallback）。
// Haiku など対応していないモデルには付けない
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const DEFAULT_FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);

const PAIR = { type: 'object', properties: { point: { type: 'string' }, evidence: { type: 'string' } }, required: ['point', 'evidence'], additionalProperties: false };
const REPORT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    good: { type: 'array', items: PAIR },
    issues: { type: 'array', items: PAIR },
    practice: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue: { type: 'string' },
          menu: { type: 'string' },
          detail: { type: 'string' },
          minutes: { type: 'integer' },
        },
        required: ['issue', 'menu', 'detail', 'minutes'],
        additionalProperties: false,
      },
    },
    watch: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'good', 'issues', 'practice', 'watch'],
  additionalProperties: false,
};

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Staff-Pass, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
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

// ---- AIふりかえり ----

const KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,23}$/;
// 名前・メモ・相手校名は AI に渡さない（アプリも送らないが、念のため Worker でも捨てる）
const DROP_KEYS = new Set(['name', 'names', 'memo', 'opponent', 'roster', 'tournament']);

/**
 * 試合の数字を、決まった形のまま長さと深さだけ制限して写す（数・短い文字・配列・オブジェクト）。
 * キーは英数字だけ。文字は120字（coachNote は400字）まで、配列は40件まで、深さは4まで。
 */
export function cleanReportValue(v, depth = 0, key = '') {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.slice(0, key === 'coachNote' ? 400 : 120);
  if (depth >= 4) return null;
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => cleanReportValue(x, depth + 1)).filter((x) => x !== null);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (!KEY_RE.test(k) || DROP_KEYS.has(k)) continue;
      const c = cleanReportValue(x, depth + 1, k);
      if (c !== null) out[k] = c;
    }
    return out;
  }
  return null;
}

/** ふりかえりの入力。得点がなければ null（AI を呼ばない） */
export function sanitizeReportPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const out = cleanReportValue(payload);
  delete out.kind;
  const score = out.score || {};
  if (!Number.isFinite(score.us) || !Number.isFinite(score.opp) || score.us + score.opp <= 0) return null;
  return out;
}

export function buildReportRequestBody(reportPayload, env = {}) {
  const model = env.REPORT_MODEL || DEFAULT_REPORT_MODEL;
  const body = {
    model,
    max_tokens: Number(env.REPORT_MAX_TOKENS) || DEFAULT_REPORT_MAX_TOKENS,
    system: REPORT_SYSTEM_PROMPT,
    output_config: {
      effort: env.REPORT_EFFORT || DEFAULT_REPORT_EFFORT,
      format: { type: 'json_schema', schema: REPORT_OUTPUT_SCHEMA },
    },
    messages: [{ role: 'user', content: JSON.stringify(reportPayload) }],
  };
  if (DEFAULT_FALLBACK_MODELS.has(model)) body.fallbacks = 'default';
  return body;
}

/** ふりかえりの応答を、決まった長さ・数に切りそろえる。良かった点も課題もなければ null */
export function filterReport(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const pairs = (list) => (Array.isArray(list) ? list : [])
    .map((x) => ({ point: cleanText(x && x.point, 80), evidence: cleanText(x && x.evidence, 80) }))
    .filter((x) => x.point)
    .slice(0, 4);
  const good = pairs(obj.good);
  const issues = pairs(obj.issues);
  if (!good.length && !issues.length) return null;
  const practice = (Array.isArray(obj.practice) ? obj.practice : [])
    .map((x) => ({
      issue: cleanText(x && x.issue, 40),
      menu: cleanText(x && x.menu, 40),
      detail: cleanText(x && x.detail, 200),
      minutes: Number.isFinite(Number(x && x.minutes)) ? Math.max(0, Math.min(60, Math.round(Number(x.minutes)))) : 0,
    }))
    .filter((x) => x.menu && x.detail)
    .slice(0, 4);
  const watch = (Array.isArray(obj.watch) ? obj.watch : []).map((x) => cleanText(x, 60)).filter(Boolean).slice(0, 4);
  return { summary: cleanText(obj.summary, 300), good, issues, practice, watch };
}

/** Claude に問い合わせて JSON を返す。だめなら { error, status? } */
async function callClaude(body, env, fetchImpl, timeoutMs) {
  let res;
  try {
    const headers = {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    };
    if (body.fallbacks) headers['anthropic-beta'] = FALLBACK_BETA;
    res = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers,
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

  if (!(await isStaffRequest(request, env))) return json({ error: 'unauthorized' }, 401, cors);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400, cors);
  }
  if (payload && payload.kind === 'game_report') {
    const report = sanitizeReportPayload(payload);
    if (!report) return json({ error: 'bad_request' }, 400, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'not_configured' }, 500, cors);
    const r = await callClaude(buildReportRequestBody(report, env), env, fetchImpl, REPORT_UPSTREAM_TIMEOUT_MS);
    if (r.error) return json(r.status ? { error: r.error, status: r.status } : { error: r.error }, 502, cors);
    const filtered = filterReport(parseJsonOutput(r.data));
    if (!filtered) return json({ error: 'bad_ai_response' }, 502, cors);
    return json(filtered, 200, cors);
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

// ----- sync.js -----
// 記録の共有（ログインと同期）。Cloudflare D1（バインディング名 DB）に保存する。外部ライブラリなし。
//
//   入口         handleBasket(request, env)：/basket/ で始まる道をまとめて受ける（AI の /basket/insight もここから）
//   最初の管理者 POST /basket/auth/setup   { setupPass（STAFF_PASS）, loginId, displayName, password } アカウントが1つもないときだけ
//   ログイン     POST /basket/auth/login   { loginId, password, device } → { token, user }
//                POST /basket/auth/logout  GET /basket/auth/me   POST /basket/auth/password { current, next }
//   アカウント   GET /basket/users   POST /basket/users { loginId, displayName, password, role }（管理者だけ）
//                POST /basket/users/update { id, displayName?, role?, disabled?, password? }   POST /basket/users/delete { id }
//   同期         POST /basket/sync { cursor, push: { games, events, team }, limit }
//                → { cursor, items: [{ t: 'g'|'e'|'s', id, gameId?, data, deleted, rev }], more, applied }
//
// 同期のしくみ：変更ごとに通し番号（rev）を付けて保存し、端末は「どこまで受け取ったか」（cursor）より新しいものを受け取る。
// 同じ記録が両方で変わったときは、端末で変えた時刻（updatedAt）の新しいほうを残す。消した記録は「消した印」で伝える。

export const MAX_PUSH = 300;
export const DEFAULT_PULL_LIMIT = 500;
export const MAX_PULL_LIMIT = 1000;
export const MAX_GAME_BYTES = 400000;
export const MAX_EVENT_BYTES = 8000;
export const MAX_TEAM_BYTES = 200000;

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** /basket/ で始まる道の入口 */
export async function handleBasket(request, env = {}, opts = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/basket/insight') return handleInsight(request, env, opts);

  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env);
  if (origin && !cors['Access-Control-Allow-Origin']) return json({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!env.DB) return json({ error: 'db_not_configured' }, 503, cors);
  await ensureSchema(env.DB);

  try {
    switch (`${request.method} ${path}`) {
      case 'POST /basket/auth/setup': return await setup(request, env, cors);
      case 'POST /basket/auth/login': return await login(request, env, cors);
      case 'POST /basket/auth/logout': return await logout(request, env, cors);
      case 'GET /basket/auth/me': return await me(request, env, cors);
      case 'POST /basket/auth/password': return await changePassword(request, env, cors);
      case 'GET /basket/users': return await listUsers(request, env, cors);
      case 'POST /basket/users': return await createUser(request, env, cors);
      case 'POST /basket/users/update': return await updateUser(request, env, cors);
      case 'POST /basket/users/delete': return await deleteUser(request, env, cors);
      case 'POST /basket/sync': return await sync(request, env, cors);
      default: return json({ error: 'not_found' }, 404, cors);
    }
  } catch (err) {
    console.error(err);
    return json({ error: 'server_error' }, 500, cors);
  }
}

// ---- ログイン ----

async function setup(request, env, cors) {
  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request' }, 400, cors);
  if (!env.STAFF_PASS || !safeEqual(String(body.setupPass || ''), env.STAFF_PASS)) return json({ error: 'unauthorized' }, 401, cors);
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (count && count.n > 0) return json({ error: 'already_set_up' }, 409, cors);
  const loginId = normalizeLoginId(body.loginId);
  const displayName = cleanName(body.displayName);
  if (!loginId || !displayName || !validPassword(body.password)) return json({ error: 'invalid_input' }, 400, cors);
  const now = Date.now();
  const id = randomId();
  await env.DB.prepare('INSERT INTO users (id, login_id, display_name, role, password_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)')
    .bind(id, loginId, displayName, 'admin', await hashPassword(body.password, iterationsFor(env)), now).run();
  const token = await createSession(env.DB, id, body.device, now);
  const user = publicUser(await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first());
  return json({ token, user }, 200, cors);
}

async function login(request, env, cors) {
  const body = await readJson(request);
  const loginId = normalizeLoginId(body && body.loginId);
  if (!loginId || typeof body.password !== 'string') return json({ error: 'invalid_input' }, 400, cors);
  const now = Date.now();
  if (await isLocked(env.DB, loginId, now)) return json({ error: 'locked' }, 429, cors);
  const row = await env.DB.prepare('SELECT * FROM users WHERE login_id = ?1').bind(loginId).first();
  const ok = row && !row.disabled && (await verifyPassword(body.password, row.password_hash));
  if (!ok) {
    await recordFailure(env.DB, loginId, now);
    return json({ error: 'wrong_login' }, 401, cors);
  }
  await clearFailures(env.DB, loginId);
  const token = await createSession(env.DB, row.id, body.device, now);
  return json({ token, user: publicUser(row) }, 200, cors);
}

async function requireUser(request, env, cors, roles = ['admin', 'staff']) {
  const user = await userFromRequest(request, env);
  if (!user) return { res: json({ error: 'unauthorized' }, 401, cors) };
  if (!roles.includes(user.role)) return { res: json({ error: 'forbidden' }, 403, cors) };
  return { user };
}

async function logout(request, env, cors) {
  const { user, res } = await requireUser(request, env, cors, ROLES);
  if (res) return res;
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(user.tokenHash).run();
  return json({ ok: true }, 200, cors);
}

async function me(request, env, cors) {
  const { user, res } = await requireUser(request, env, cors, ROLES);
  if (res) return res;
  const { tokenHash, ...rest } = user;
  return json({ user: rest }, 200, cors);
}

async function changePassword(request, env, cors) {
  const { user, res } = await requireUser(request, env, cors, ROLES);
  if (res) return res;
  const body = await readJson(request);
  if (!body || !validPassword(body.next)) return json({ error: 'invalid_input' }, 400, cors);
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?1').bind(user.id).first();
  if (!row || !(await verifyPassword(String(body.current || ''), row.password_hash))) return json({ error: 'wrong_login' }, 401, cors);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3').bind(await hashPassword(body.next, iterationsFor(env)), Date.now(), user.id),
    // ほかの端末のログインは切る（今の端末はそのまま）
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1 AND token_hash <> ?2').bind(user.id, user.tokenHash),
  ]);
  return json({ ok: true }, 200, cors);
}

// ---- アカウント（管理者だけ） ----

async function listUsers(request, env, cors) {
  const { res } = await requireUser(request, env, cors, ['admin']);
  if (res) return res;
  const { results } = await env.DB.prepare('SELECT * FROM users ORDER BY created_at').all();
  return json({ users: results.map(publicUser) }, 200, cors);
}

async function createUser(request, env, cors) {
  const { res } = await requireUser(request, env, cors, ['admin']);
  if (res) return res;
  const body = await readJson(request);
  const loginId = normalizeLoginId(body && body.loginId);
  const displayName = cleanName(body && body.displayName);
  // 生徒のアカウントは今後（今は管理者とスタッフだけ作れる）
  const role = body && (body.role === 'admin' || body.role === 'staff') ? body.role : null;
  if (!loginId || !displayName || !role || !validPassword(body.password)) return json({ error: 'invalid_input' }, 400, cors);
  const exists = await env.DB.prepare('SELECT id FROM users WHERE login_id = ?1').bind(loginId).first();
  if (exists) return json({ error: 'login_id_taken' }, 409, cors);
  const now = Date.now();
  const id = randomId();
  await env.DB.prepare('INSERT INTO users (id, login_id, display_name, role, password_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)')
    .bind(id, loginId, displayName, role, await hashPassword(body.password, iterationsFor(env)), now).run();
  return json({ user: publicUser(await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first()) }, 200, cors);
}

async function adminCount(db, exceptId) {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id <> ?1").bind(exceptId).first();
  return r ? r.n : 0;
}

async function updateUser(request, env, cors) {
  const { user, res } = await requireUser(request, env, cors, ['admin']);
  if (res) return res;
  const body = await readJson(request);
  const row = body && typeof body.id === 'string' ? await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(body.id).first() : null;
  if (!row) return json({ error: 'not_found' }, 404, cors);
  const next = { display_name: row.display_name, role: row.role, disabled: row.disabled, password_hash: row.password_hash };
  if (body.displayName !== undefined) {
    const n = cleanName(body.displayName);
    if (!n) return json({ error: 'invalid_input' }, 400, cors);
    next.display_name = n;
  }
  if (body.role !== undefined) {
    if (body.role !== 'admin' && body.role !== 'staff') return json({ error: 'invalid_input' }, 400, cors);
    next.role = body.role;
  }
  if (body.disabled !== undefined) next.disabled = body.disabled ? 1 : 0;
  if (body.password !== undefined) {
    if (!validPassword(body.password)) return json({ error: 'invalid_input' }, 400, cors);
    next.password_hash = await hashPassword(body.password, iterationsFor(env));
  }
  // 管理者がいなくならないようにする
  const losesAdmin = row.role === 'admin' && (next.role !== 'admin' || next.disabled);
  if (losesAdmin && (await adminCount(env.DB, row.id)) === 0) return json({ error: 'last_admin' }, 409, cors);
  const stmts = [
    env.DB.prepare('UPDATE users SET display_name = ?1, role = ?2, disabled = ?3, password_hash = ?4, updated_at = ?5 WHERE id = ?6')
      .bind(next.display_name, next.role, next.disabled, next.password_hash, Date.now(), row.id),
  ];
  // 使えなくした・パスワードを変えたときは、その人のログインを切る（自分の今の端末は残す）
  if (next.disabled || body.password !== undefined) {
    stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1 AND token_hash <> ?2').bind(row.id, user.tokenHash));
  }
  await env.DB.batch(stmts);
  return json({ user: publicUser(await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(row.id).first()) }, 200, cors);
}

async function deleteUser(request, env, cors) {
  const { user, res } = await requireUser(request, env, cors, ['admin']);
  if (res) return res;
  const body = await readJson(request);
  const row = body && typeof body.id === 'string' ? await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(body.id).first() : null;
  if (!row) return json({ error: 'not_found' }, 404, cors);
  if (row.id === user.id) return json({ error: 'cannot_delete_self' }, 409, cors);
  if (row.role === 'admin' && (await adminCount(env.DB, row.id)) === 0) return json({ error: 'last_admin' }, 409, cors);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(row.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(row.id),
  ]);
  return json({ ok: true }, 200, cors);
}

// ---- 同期 ----

function validId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
}

/**
 * 送られてきた変更を、決まった形に整える（形の違うものは捨てる）。
 * 戻り値 { games, events, team, rejected }
 */
export function cleanPush(push) {
  const out = { games: [], events: [], team: null, rejected: 0 };
  if (!push || typeof push !== 'object') return out;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);
  for (const g of Array.isArray(push.games) ? push.games.slice(0, MAX_PUSH) : []) {
    const updatedAt = num(g && g.updatedAt);
    const data = g && typeof g.data === 'string' ? g.data : '{}';
    if (!g || !validId(g.id) || !updatedAt || data.length > MAX_GAME_BYTES) {
      out.rejected += 1;
      continue;
    }
    out.games.push({ id: g.id, data: g.deleted ? '{}' : data, updatedAt, deleted: g.deleted ? 1 : 0 });
  }
  for (const e of Array.isArray(push.events) ? push.events.slice(0, MAX_PUSH) : []) {
    const updatedAt = num(e && e.updatedAt);
    const data = e && typeof e.data === 'string' ? e.data : '{}';
    if (!e || !validId(e.id) || !validId(e.gameId) || !updatedAt || data.length > MAX_EVENT_BYTES) {
      out.rejected += 1;
      continue;
    }
    out.events.push({ id: e.id, gameId: e.gameId, data: e.deleted ? '{}' : data, updatedAt, deleted: e.deleted ? 1 : 0 });
  }
  const t = push.team;
  if (t && typeof t.data === 'string' && t.data.length <= MAX_TEAM_BYTES && num(t.updatedAt)) out.team = { data: t.data, updatedAt: num(t.updatedAt) };
  return out;
}

const REV = "(SELECT value FROM meta WHERE key = 'rev')";

/**
 * 変更をまとめて保存する（1つのトランザクション）。
 * 行ごとに通し番号（今の rev ＋ 何番目か）を付け、最後に rev を進める。
 * すでにある行は、端末で変えた時刻（updatedAt）が新しいときだけ置き換える。
 */
export function pushStatements(db, clean, userId) {
  const stmts = [];
  let offset = 0;
  if (clean.games.length) {
    stmts.push(db.prepare(
      `INSERT INTO games (id, data, updated_at, rev, updated_by, deleted)
       SELECT json_extract(j.value, '$.id'), json_extract(j.value, '$.data'), json_extract(j.value, '$.updatedAt'),
              ${REV} + ?2 + j.key + 1, ?3, json_extract(j.value, '$.deleted')
       FROM json_each(?1) AS j WHERE true
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, rev = excluded.rev,
         updated_by = excluded.updated_by, deleted = excluded.deleted
       WHERE excluded.updated_at > games.updated_at`,
    ).bind(JSON.stringify(clean.games), offset, userId));
    offset += clean.games.length;
  }
  if (clean.events.length) {
    stmts.push(db.prepare(
      `INSERT INTO events (id, game_id, data, updated_at, rev, deleted)
       SELECT json_extract(j.value, '$.id'), json_extract(j.value, '$.gameId'), json_extract(j.value, '$.data'),
              json_extract(j.value, '$.updatedAt'), ${REV} + ?2 + j.key + 1, json_extract(j.value, '$.deleted')
       FROM json_each(?1) AS j WHERE true
       ON CONFLICT(id) DO UPDATE SET game_id = excluded.game_id, data = excluded.data, updated_at = excluded.updated_at,
         rev = excluded.rev, deleted = excluded.deleted
       WHERE excluded.updated_at > events.updated_at`,
    ).bind(JSON.stringify(clean.events), offset));
    offset += clean.events.length;
  }
  if (clean.team) {
    stmts.push(db.prepare(
      `INSERT INTO team (key, data, updated_at, rev) VALUES ('settings', ?1, ?2, ${REV} + ?3 + 1)
       ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, rev = excluded.rev
       WHERE excluded.updated_at > team.updated_at`,
    ).bind(clean.team.data, clean.team.updatedAt, offset));
    offset += 1;
  }
  if (offset) stmts.push(db.prepare("UPDATE meta SET value = value + ?1 WHERE key = 'rev'").bind(offset));
  return stmts;
}

export function pullStatement(db, cursor, limit) {
  return db.prepare(
    `SELECT 'g' AS t, id, NULL AS game_id, data, deleted, rev FROM games WHERE rev > ?1
     UNION ALL SELECT 'e' AS t, id, game_id, data, deleted, rev FROM events WHERE rev > ?1
     UNION ALL SELECT 's' AS t, key AS id, NULL AS game_id, data, 0 AS deleted, rev FROM team WHERE rev > ?1
     ORDER BY rev LIMIT ?2`,
  ).bind(cursor, limit);
}

async function sync(request, env, cors) {
  const { user, res } = await requireUser(request, env, cors, ['admin', 'staff']);
  if (res) return res;
  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request' }, 400, cors);
  const cursor = Number.isInteger(body.cursor) && body.cursor >= 0 ? body.cursor : 0;
  const limit = Math.min(MAX_PULL_LIMIT, Number.isInteger(body.limit) && body.limit > 0 ? body.limit : DEFAULT_PULL_LIMIT);
  const clean = cleanPush(body.push);
  const stmts = pushStatements(env.DB, clean, user.id);
  if (stmts.length) await env.DB.batch(stmts);
  const { results } = await pullStatement(env.DB, cursor, limit).all();
  const items = results.map((r) => {
    const item = { t: r.t, id: r.id, data: r.data, deleted: !!r.deleted, rev: r.rev };
    if (r.t === 'e') item.gameId = r.game_id;
    return item;
  });
  return json({
    cursor: items.length ? items[items.length - 1].rev : cursor,
    items,
    more: items.length === limit,
    applied: { games: clean.games.length, events: clean.events.length, team: clean.team ? 1 : 0, rejected: clean.rejected },
  }, 200, cors);
}

// ===== 入口：/basket/ で始まる道（AI・ログイン・同期）を受ける =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/basket/')) return handleBasket(request, env);
    return new Response('Not found', { status: 404 });
  },
};
