// 記録の共有（ログインと同期）。Cloudflare D1（バインディング名 DB）に保存する。外部ライブラリなし。
//
//   入口         handleBasket(request, env)：/basket/ で始まる道をまとめて受ける（AI の /basket/insight もここから）
//   最初の管理者 POST /basket/auth/setup   { setupPass（STAFF_PASS）, loginId, displayName, password } アカウントが1つもないときだけ
//   ログイン     POST /basket/auth/login   { loginId, password, device } → { token, user }
//                POST /basket/auth/logout  GET /basket/auth/me   POST /basket/auth/password { current, next }
//   アカウント   GET /basket/users   POST /basket/users { loginId, displayName, password, role: admin|staff|student }（管理者だけ）
//                student＝部員（見るだけ）：同期で受け取るだけ。AI の結果・チェック項目・動画の URL は渡さない
//                POST /basket/users/update { id, displayName?, role?, disabled?, password? }   POST /basket/users/delete { id }
//   同期         POST /basket/sync { cursor, push: { games, events, team }, limit }
//                → { cursor, items: [{ t: 'g'|'e'|'s', id, gameId?, data, deleted, rev }], more, applied }
//
// 同期のしくみ：変更ごとに通し番号（rev）を付けて保存し、端末は「どこまで受け取ったか」（cursor）より新しいものを受け取る。
// 同じ記録が両方で変わったときは、端末で変えた時刻（updatedAt）の新しいほうを残す。消した記録は「消した印」で伝える。
import { json, corsHeaders, handleInsight } from './insight.js';
import {
  ensureSchema, userFromRequest, createSession, hashPassword, verifyPassword, iterationsFor, normalizeLoginId,
  validPassword, cleanName, publicUser, randomId, isLocked, recordFailure, clearFailures, safeEqual, ROLES,
} from './auth.js';

export const MAX_PUSH = 300;
export const DEFAULT_PULL_LIMIT = 500;
export const MAX_PULL_LIMIT = 1000;
export const MAX_GAME_BYTES = 400000;
export const MAX_EVENT_BYTES = 8000;
export const MAX_TEAM_BYTES = 200000;

// AI特筆データ・対処の例・AIふりかえり（と、ふりかえりで AI に伝えたメモ）は管理者だけが見る（js/sync-core.js と同じ）
export const AI_GAME_KEYS = ['insights', 'advice', 'reports', 'reportNote'];
// 管理者だけが変えられるチームの設定（AI に伝えない項目）
export const ADMIN_TEAM_KEYS = ['aiExclude'];
// 部員（見るだけ：student）に渡すもの。試合からは AI の結果に加えて、チェック項目（コーチの評価とメモ）と動画の URL を外す。
// チームの設定は守備隊形の並びだけ（集計の表の順に使う）
export const VIEWER_STRIP_KEYS = [...AI_GAME_KEYS, 'checklist', 'videos'];
export const VIEWER_TEAM_KEYS = ['defenses'];

function parseObject(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** 管理者でない人に渡す試合：AI の結果を外す */
export function stripAiData(data) {
  const g = parseObject(data);
  if (!g) return data;
  for (const k of AI_GAME_KEYS) delete g[k];
  return JSON.stringify(g);
}

/**
 * 管理者でない人が送ってきた試合：送られてきた AI の結果は使わず、共有に保存してある AI の結果を残す
 * （スタッフの端末で名簿などを直しても、管理者の AI の結果が消えないように）
 */
export function keepAiData(incoming, existing) {
  const g = parseObject(incoming);
  if (!g) return incoming;
  for (const k of AI_GAME_KEYS) delete g[k];
  const old = existing ? parseObject(existing) : null;
  if (old) for (const k of AI_GAME_KEYS) if (old[k] !== undefined) g[k] = old[k];
  return JSON.stringify(g);
}

/** 部員に渡す試合：AI の結果・チェック項目・動画の URL を外す */
export function viewerGameData(data) {
  const g = parseObject(data);
  if (!g) return data;
  for (const k of VIEWER_STRIP_KEYS) delete g[k];
  return JSON.stringify(g);
}

/** 部員に渡すチームの設定：守備隊形の並びだけ */
export function viewerTeamData(data) {
  const t = parseObject(data);
  if (!t) return data;
  const out = {};
  for (const k of VIEWER_TEAM_KEYS) if (t[k] !== undefined) out[k] = t[k];
  return JSON.stringify(out);
}

/** 管理者でない人が送ってきたチームの設定：管理者だけが変えられる項目は、共有に保存してある値を残す */
export function keepAdminTeamKeys(incoming, existing) {
  const t = parseObject(incoming);
  if (!t) return incoming;
  for (const k of ADMIN_TEAM_KEYS) delete t[k];
  const old = existing ? parseObject(existing) : null;
  if (old) for (const k of ADMIN_TEAM_KEYS) if (old[k] !== undefined) t[k] = old[k];
  return JSON.stringify(t);
}

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
  const role = body && ROLES.includes(body.role) ? body.role : null;
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
    if (!ROLES.includes(body.role)) return json({ error: 'invalid_input' }, 400, cors);
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
  const { user, res } = await requireUser(request, env, cors, ['admin', 'staff', 'student']);
  if (res) return res;
  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request' }, 400, cors);
  const cursor = Number.isInteger(body.cursor) && body.cursor >= 0 ? body.cursor : 0;
  const limit = Math.min(MAX_PULL_LIMIT, Number.isInteger(body.limit) && body.limit > 0 ? body.limit : DEFAULT_PULL_LIMIT);
  const isAdmin = user.role === 'admin';
  const isViewer = user.role === 'student';
  // 部員は見るだけ：送ってきた変更は使わない
  const clean = cleanPush(isViewer ? null : body.push);
  if (!isAdmin) {
    // 管理者でない人の変更では、AI の結果と管理者だけの設定を、共有に保存してある値のまま残す
    const ids = clean.games.filter((g) => !g.deleted).map((g) => g.id);
    if (ids.length) {
      const { results: rows } = await env.DB.prepare('SELECT id, data FROM games WHERE id IN (SELECT value FROM json_each(?1))')
        .bind(JSON.stringify(ids)).all();
      const saved = new Map(rows.map((r) => [r.id, r.data]));
      for (const g of clean.games) if (!g.deleted) g.data = keepAiData(g.data, saved.get(g.id));
    }
    if (clean.team) {
      const row = await env.DB.prepare("SELECT data FROM team WHERE key = 'settings'").first();
      clean.team.data = keepAdminTeamKeys(clean.team.data, row ? row.data : null);
    }
  }
  const stmts = pushStatements(env.DB, clean, user.id);
  if (stmts.length) await env.DB.batch(stmts);
  const { results } = await pullStatement(env.DB, cursor, limit).all();
  const items = results.map((r) => {
    // 管理者でない人には、試合の AI の結果を外して渡す（部員にはチェック項目・動画の URL も外し、チームの設定は守備隊形だけ）
    let data = r.data;
    if (!r.deleted && r.t === 'g') data = isViewer ? viewerGameData(r.data) : isAdmin ? r.data : stripAiData(r.data);
    if (isViewer && r.t === 's') data = viewerTeamData(r.data);
    const item = { t: r.t, id: r.id, data, deleted: !!r.deleted, rev: r.rev };
    if (r.t === 'e') item.gameId = r.game_id;
    return item;
  });
  return json({
    cursor: items.length ? items[items.length - 1].rev : cursor,
    items,
    more: items.length === limit,
    // この Worker は AI の結果を管理者だけに渡す（アプリはこれを見て、管理者でない端末に残っている AI の結果を消す）
    aiPolicy: 'admin_only',
    readOnly: isViewer,
    applied: { games: clean.games.length, events: clean.events.length, team: clean.team ? 1 : 0, rejected: clean.rejected },
  }, 200, cors);
}
