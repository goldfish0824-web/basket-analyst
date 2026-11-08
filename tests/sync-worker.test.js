import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleBasket, cleanPush, MAX_PUSH } from '../worker/sync.js';
import { hashPassword, verifyPassword, normalizeLoginId, validPassword, schemaLines } from '../worker/auth.js';
import { fakeD1 } from './helpers/fake-d1.js';

const ORIGIN = 'https://goldfish0824-web.github.io';

function makeEnv() {
  return { DB: fakeD1(), STAFF_PASS: 'staff-pass-1', PBKDF2_ITERATIONS: '1000', ANTHROPIC_API_KEY: 'k' };
}

function call(env, path, { method = 'POST', body, token, origin = ORIGIN, pass } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  if (pass) headers['X-Staff-Pass'] = pass;
  return handleBasket(new Request(`https://w.example${path}`, {
    method, headers, body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  }), env);
}

async function setupAdmin(env) {
  const res = await call(env, '/basket/auth/setup', { body: { setupPass: 'staff-pass-1', loginId: 'Yamada', displayName: '山田', password: 'password-123', device: 'iPad' } });
  assert.equal(res.status, 200);
  return res.json();
}

test('パスワードは塩つきのハッシュで保存し、照合できる', async () => {
  const h1 = await hashPassword('password-123', 1000);
  const h2 = await hashPassword('password-123', 1000);
  assert.notEqual(h1, h2, '塩が違う');
  assert.match(h1, /^pbkdf2\$sha256\$1000\$/);
  assert.equal(await verifyPassword('password-123', h1), true);
  assert.equal(await verifyPassword('password-124', h1), false);
  assert.equal(await verifyPassword('x', 'bad'), false);
  assert.equal(normalizeLoginId(' Yamada.T '), 'yamada.t');
  assert.equal(normalizeLoginId('ab'), null);
  assert.equal(normalizeLoginId('山田'), null);
  assert.equal(validPassword('1234567'), false);
  assert.equal(validPassword('12345678'), true);
});

test('データベース（DB）がつながっていなければ 503。表は初回に自動で作る', async () => {
  const res = await call({ STAFF_PASS: 'x' }, '/basket/auth/login', { body: { loginId: 'abc', password: 'password-123' } });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'db_not_configured' });
  const env = makeEnv();
  await call(env, '/basket/auth/login', { body: { loginId: 'abc', password: 'password-123' } });
  const tables = env.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ['events', 'games', 'login_failures', 'meta', 'sessions', 'team', 'users']);
  // D1 の exec は1行ずつ：複数行の文がない
  const lines = schemaLines().split('\n');
  assert.ok(lines.length >= 12 && lines.every((l) => /^(CREATE|INSERT) .*;$/.test(l)), lines.join('\n'));
});

test('最初の管理者：スタッフ用パスコードが必要。2回目は作れない', async () => {
  const env = makeEnv();
  const bad = await call(env, '/basket/auth/setup', { body: { setupPass: 'wrong', loginId: 'yamada', displayName: '山田', password: 'password-123' } });
  assert.equal(bad.status, 401);
  const { token, user } = await setupAdmin(env);
  assert.ok(token.length >= 40);
  assert.deepEqual({ loginId: user.loginId, displayName: user.displayName, role: user.role }, { loginId: 'yamada', displayName: '山田', role: 'admin' });
  const again = await call(env, '/basket/auth/setup', { body: { setupPass: 'staff-pass-1', loginId: 'sato', displayName: '佐藤', password: 'password-123' } });
  assert.equal(again.status, 409);
  // 鍵はハッシュだけを保存する
  const row = env.DB.raw.prepare('SELECT token_hash FROM sessions').get();
  assert.notEqual(row.token_hash, token);
});

test('ログイン：まちがえると 401、10分に5回まちがえると15分ロック（正しくても入れない）', async () => {
  const env = makeEnv();
  await setupAdmin(env);
  for (let i = 0; i < 4; i++) {
    assert.equal((await call(env, '/basket/auth/login', { body: { loginId: 'yamada', password: 'wrong-pass' } })).status, 401);
  }
  const ok = await call(env, '/basket/auth/login', { body: { loginId: 'YAMADA', password: 'password-123' } });
  assert.equal(ok.status, 200, '成功すると数え直し');
  for (let i = 0; i < 5; i++) await call(env, '/basket/auth/login', { body: { loginId: 'yamada', password: 'wrong-pass' } });
  const locked = await call(env, '/basket/auth/login', { body: { loginId: 'yamada', password: 'password-123' } });
  assert.equal(locked.status, 429);
  assert.equal((await call(env, '/basket/auth/login', { body: { loginId: 'nobody', password: 'password-123' } })).status, 401);
});

test('ログインの鍵：me・ログアウト・AI の問い合わせ（スタッフ用パスコードの代わり）', async () => {
  const env = makeEnv();
  const { token } = await setupAdmin(env);
  const me = await call(env, '/basket/auth/me', { method: 'GET', token });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.loginId, 'yamada');
  assert.equal((await call(env, '/basket/auth/me', { method: 'GET', token: 'x'.repeat(43) })).status, 401);
  // AI（候補0件の接続テスト）はログインの鍵でも使える
  const ai = await call(env, '/basket/insight', { token, body: { kind: 'quarter_insight', quarterEnded: 0, score: { us: 0, opp: 0 }, candidates: [] } });
  assert.equal(ai.status, 200);
  assert.equal((await call(env, '/basket/insight', { body: { kind: 'quarter_insight', candidates: [] } })).status, 401);
  assert.equal((await call(env, '/basket/auth/logout', { token })).status, 200);
  assert.equal((await call(env, '/basket/auth/me', { method: 'GET', token })).status, 401);
});

test('アカウント：管理者だけが作れる・一覧を見られる。スタッフは 403', async () => {
  const env = makeEnv();
  const { token } = await setupAdmin(env);
  const created = await call(env, '/basket/users', { token, body: { loginId: 'sato', displayName: '佐藤', password: 'password-456', role: 'staff' } });
  assert.equal(created.status, 200);
  const sato = (await created.json()).user;
  assert.equal(sato.role, 'staff');
  assert.equal((await call(env, '/basket/users', { token, body: { loginId: 'sato', displayName: '佐藤2', password: 'password-456', role: 'staff' } })).status, 409);
  assert.equal((await call(env, '/basket/users', { token, body: { loginId: 'kato', displayName: '加藤', password: 'short', role: 'staff' } })).status, 400);
  assert.equal((await call(env, '/basket/users', { token, body: { loginId: 'kato', displayName: '加藤', password: 'password-456', role: 'student' } })).status, 400, '生徒は今後');
  const list = await (await call(env, '/basket/users', { method: 'GET', token })).json();
  assert.deepEqual(list.users.map((u) => u.loginId), ['yamada', 'sato']);
  assert.ok(!JSON.stringify(list).includes('pbkdf2'), 'パスワードのハッシュは返さない');
  const st = await (await call(env, '/basket/auth/login', { body: { loginId: 'sato', password: 'password-456' } })).json();
  assert.equal((await call(env, '/basket/users', { method: 'GET', token: st.token })).status, 403);
});

test('アカウント：使えなくするとログインが切れる。最後の管理者は外せない・自分は消せない', async () => {
  const env = makeEnv();
  const { token, user: admin } = await setupAdmin(env);
  const sato = (await (await call(env, '/basket/users', { token, body: { loginId: 'sato', displayName: '佐藤', password: 'password-456', role: 'staff' } })).json()).user;
  const st = await (await call(env, '/basket/auth/login', { body: { loginId: 'sato', password: 'password-456' } })).json();
  const off = await call(env, '/basket/users/update', { token, body: { id: sato.id, disabled: true } });
  assert.equal(off.status, 200);
  assert.equal((await call(env, '/basket/auth/me', { method: 'GET', token: st.token })).status, 401);
  assert.equal((await call(env, '/basket/auth/login', { body: { loginId: 'sato', password: 'password-456' } })).status, 401);
  assert.equal((await call(env, '/basket/users/update', { token, body: { id: admin.id, role: 'staff' } })).status, 409);
  assert.equal((await call(env, '/basket/users/delete', { token, body: { id: admin.id } })).status, 409);
  assert.equal((await call(env, '/basket/users/delete', { token, body: { id: sato.id } })).status, 200);
  // パスワードの再設定
  const kato = (await (await call(env, '/basket/users', { token, body: { loginId: 'kato', displayName: '加藤', password: 'password-456', role: 'staff' } })).json()).user;
  assert.equal((await call(env, '/basket/users/update', { token, body: { id: kato.id, password: 'new-password-1' } })).status, 200);
  assert.equal((await call(env, '/basket/auth/login', { body: { loginId: 'kato', password: 'new-password-1' } })).status, 200);
});

test('パスワードを変える：今のパスワードが必要。ほかの端末のログインは切れる', async () => {
  const env = makeEnv();
  const { token } = await setupAdmin(env);
  const other = (await (await call(env, '/basket/auth/login', { body: { loginId: 'yamada', password: 'password-123' } })).json()).token;
  assert.equal((await call(env, '/basket/auth/password', { token, body: { current: 'wrong-pass', next: 'password-999' } })).status, 401);
  assert.equal((await call(env, '/basket/auth/password', { token, body: { current: 'password-123', next: 'password-999' } })).status, 200);
  assert.equal((await call(env, '/basket/auth/me', { method: 'GET', token })).status, 200);
  assert.equal((await call(env, '/basket/auth/me', { method: 'GET', token: other })).status, 401);
});

const g = (id, updatedAt, extra = {}) => ({ id, data: JSON.stringify({ id, opponent: '架空高校', ...extra }), updatedAt });
const ev = (id, gameId, updatedAt, seq) => ({ id, gameId, data: JSON.stringify({ id, gameId, seq, type: 'fg' }), updatedAt });

test('同期：送った変更を、別の端末が通し番号の順に受け取る（どこまで受け取ったかを続きから）', async () => {
  const env = makeEnv();
  const { token } = await setupAdmin(env);
  const a = await (await call(env, '/basket/sync', { token, body: { cursor: 0, push: { games: [g('g1', 100)], events: [ev('e1', 'g1', 100, 1), ev('e2', 'g1', 101, 2)], team: { data: '{"defenses":["マンツー"]}', updatedAt: 50 } } } })).json();
  assert.deepEqual(a.applied, { games: 1, events: 2, team: 1, rejected: 0 });
  assert.deepEqual(a.items.map((i) => `${i.t}:${i.id}:${i.rev}`), ['g:g1:1', 'e:e1:2', 'e:e2:3', 's:settings:4']);
  assert.equal(a.cursor, 4);
  assert.equal(a.items[1].gameId, 'g1');
  // 別の端末：途中から2件ずつ
  const b1 = await (await call(env, '/basket/sync', { token, body: { cursor: 0, limit: 2 } })).json();
  assert.equal(b1.items.length, 2);
  assert.equal(b1.more, true);
  const b2 = await (await call(env, '/basket/sync', { token, body: { cursor: b1.cursor, limit: 2 } })).json();
  assert.deepEqual(b2.items.map((i) => i.id), ['e2', 'settings']);
  const b3 = await (await call(env, '/basket/sync', { token, body: { cursor: b2.cursor, limit: 2 } })).json();
  assert.deepEqual(b3.items, []);
  assert.equal(b3.cursor, b2.cursor);
  assert.equal(b3.more, false);
});

test('同期：同じ記録は、端末で変えた時刻の新しいほうを残す。消した印も伝わる', async () => {
  const env = makeEnv();
  const { token } = await setupAdmin(env);
  await call(env, '/basket/sync', { token, body: { push: { games: [g('g1', 200, { note: '新しい' })] } } });
  const old = await (await call(env, '/basket/sync', { token, body: { cursor: 1, push: { games: [g('g1', 150, { note: '古い' })] } } })).json();
  assert.deepEqual(old.items, [], '古い変更は置き換えない');
  const row = env.DB.raw.prepare("SELECT data, rev FROM games WHERE id = 'g1'").get();
  assert.match(row.data, /新しい/);
  assert.equal(row.rev, 1);
  // 消した印
  const del = await (await call(env, '/basket/sync', { token, body: { cursor: 1, push: { games: [{ id: 'g1', updatedAt: 300, deleted: true, data: '{"secret":1}' }], events: [{ id: 'e9', gameId: 'g1', updatedAt: 300, deleted: true }] } } })).json();
  assert.deepEqual(del.items.map((i) => [i.id, i.deleted, i.data]), [['g1', true, '{}'], ['e9', true, '{}']]);
});

test('同期：生徒・ログインなしは使えない。形の違う変更は捨てる', async () => {
  const env = makeEnv();
  await setupAdmin(env);
  assert.equal((await call(env, '/basket/sync', { body: { cursor: 0 } })).status, 401);
  // 生徒（今後）のアカウントを直接作って試す
  env.DB.raw.prepare("INSERT INTO users (id, login_id, display_name, role, password_hash, created_at, updated_at) VALUES ('s1', 'student1', '生徒', 'student', ?, 1, 1)").run(await hashPassword('password-123', 1000));
  const st = await (await call(env, '/basket/auth/login', { body: { loginId: 'student1', password: 'password-123' } })).json();
  assert.equal((await call(env, '/basket/sync', { token: st.token, body: { cursor: 0 } })).status, 403);
  const c = cleanPush({
    games: [{ id: 'ok', updatedAt: 1, data: '{}' }, { id: 'bad id!', updatedAt: 1 }, { id: 'nostamp' }, { id: 'big', updatedAt: 1, data: 'x'.repeat(500000) }],
    events: [{ id: 'e1', updatedAt: 1, data: '{}' }, { id: 'e2', gameId: 'g', updatedAt: 1, data: '{}' }],
    team: { data: '{}', updatedAt: 0 },
  });
  assert.deepEqual(c.games.map((x) => x.id), ['ok']);
  assert.deepEqual(c.events.map((x) => x.id), ['e2']);
  assert.equal(c.team, null);
  assert.equal(c.rejected, 4);
  assert.equal(cleanPush({ games: Array.from({ length: MAX_PUSH + 50 }, (_, i) => ({ id: `g${i}`, updatedAt: 1, data: '{}' })) }).games.length, MAX_PUSH);
});

test('同期：1回の問い合わせでデータベースに出す命令は少ない（無料プランの上限 50）', async () => {
  const env = makeEnv();
  const { token } = await setupAdmin(env);
  const events = Array.from({ length: 300 }, (_, i) => ev(`e${i}`, 'g1', 100 + i, i));
  const before = env.DB.queries;
  const r = await call(env, '/basket/sync', { token, body: { cursor: 0, push: { games: [g('g1', 100)], events } } });
  assert.equal(r.status, 200);
  assert.ok(env.DB.queries - before <= 10, `${env.DB.queries - before} 回`);
  assert.equal((await r.json()).items.length, 301);
});

test('AI の結果は管理者だけ：スタッフには外して渡し、スタッフが送っても消えない。スタッフの AI は 403', async () => {
  const env = makeEnv();
  const admin = (await setupAdmin(env)).token;
  await call(env, '/basket/users', { token: admin, body: { loginId: 'sato', displayName: '佐藤', password: 'password-456', role: 'staff' } });
  const staff = (await (await call(env, '/basket/auth/login', { body: { loginId: 'sato', password: 'password-456' } })).json()).token;
  const ai = { insights: [{ quarter: 2, items: [{ line: '相手#7、右ドライブで5本中4本成功' }] }], advice: [{ quarter: 2 }], reports: [{ summary: '講評' }], reportNote: '県大会' };
  const game = (extra) => JSON.stringify({ id: 'g1', opponent: '架空高校', roster: [{ number: '4', name: 'A' }], ...extra });
  // 管理者が AI の結果つきで送る（チームの設定も）
  let res = await call(env, '/basket/sync', { token: admin, body: { cursor: 0, push: { games: [{ id: 'g1', data: game(ai), updatedAt: 100 }], team: { data: JSON.stringify({ defenses: ['マンツー'], aiExclude: { rebounds: true } }), updatedAt: 100 } } } });
  let body = await res.json();
  assert.equal(body.aiPolicy, 'admin_only');
  assert.deepEqual(JSON.parse(body.items.find((i) => i.t === 'g').data).insights, ai.insights, '管理者には AI の結果も渡す');
  // スタッフが受け取る：AI の結果はない
  body = await (await call(env, '/basket/sync', { token: staff, body: { cursor: 0 } })).json();
  const got = JSON.parse(body.items.find((i) => i.t === 'g').data);
  for (const k of ['insights', 'advice', 'reports', 'reportNote']) assert.equal(k in got, false, k);
  assert.equal(got.opponent, '架空高校');
  // スタッフが名簿を直して送る（AI の結果を消そうとしたり、勝手に入れようとしたりしても無視）。チームの設定の aiExclude も変えられない
  const staffGame = game({ roster: [{ number: '4', name: 'A' }, { number: '5', name: 'B' }], insights: [{ quarter: 9, items: [{ line: 'にせもの' }] }] });
  await call(env, '/basket/sync', { token: staff, body: { cursor: body.cursor, push: { games: [{ id: 'g1', data: staffGame, updatedAt: 200 }], team: { data: JSON.stringify({ defenses: ['マンツー', '2-3ゾーン'], aiExclude: { rebounds: false } }), updatedAt: 200 } } } });
  // 管理者が受け取る：名簿は新しく、AI の結果は管理者のもののまま。aiExclude も管理者の値
  body = await (await call(env, '/basket/sync', { token: admin, body: { cursor: 0 } })).json();
  const g = JSON.parse(body.items.find((i) => i.t === 'g').data);
  assert.equal(g.roster.length, 2);
  assert.deepEqual(g.insights, ai.insights);
  assert.deepEqual(g.reports, ai.reports);
  assert.equal(g.reportNote, '県大会');
  const team = JSON.parse(body.items.find((i) => i.t === 's').data);
  assert.deepEqual(team.defenses, ['マンツー', '2-3ゾーン']);
  assert.deepEqual(team.aiExclude, { rebounds: true });
  // AI の問い合わせ：スタッフのログインは 403、管理者・パスコードは通る（AI の中身は呼ばずに形の確認だけ）
  const q = { kind: 'quarter_insight', quarterEnded: 0, score: { us: 0, opp: 0 }, candidates: [] };
  const sr = await call(env, '/basket/insight', { token: staff, body: q });
  assert.equal(sr.status, 403);
  assert.deepEqual(await sr.json(), { error: 'admin_only' });
  assert.equal((await call(env, '/basket/insight', { token: staff, pass: 'staff-pass-1', body: q })).status, 403, 'スタッフのログインならパスコードがあっても使えない');
  assert.notEqual((await call(env, '/basket/insight', { token: admin, body: q })).status, 403);
  assert.notEqual((await call(env, '/basket/insight', { pass: 'staff-pass-1', body: q })).status, 401);
});
