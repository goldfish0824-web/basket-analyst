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
