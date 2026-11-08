// 記録の共有：ログインと同期（Worker の /basket/auth/*・/basket/users・/basket/sync）。
// 判断の部分は sync-core.js（テストあり）、保存は db.js。
//
// 同期するとき：ログインしたとき・アプリを開いたとき・前面に出たとき・電波が戻ったとき・
//               端末で記録を変えてから少したったとき（記録中に何度も通信しないよう20秒まとめる）・「今すぐ同期」
import * as db from './db.js';
import { buildPush, planApply, workerBase, syncErrorText, canUseAi, isViewer } from './sync-core.js';

const SYNC_DEBOUNCE_MS = 20000;
const SYNC_MIN_INTERVAL_MS = 30000;
const REQUEST_TIMEOUT_MS = 30000;

const listeners = new Set();
const status = { state: 'idle', lastSyncAt: null, pending: 0, error: '', received: 0 };
let appRef = null;
let timer = null;
let running = null;
let queued = null;
let lastAttempt = 0;

/** 状態が変わったら呼ばれる（設定画面・ホームの表示用）。戻り値で解除 */
export function onSyncStatus(fn) {
  listeners.add(fn);
  fn({ ...status });
  return () => listeners.delete(fn);
}

function emit(patch) {
  Object.assign(status, patch);
  for (const fn of listeners) {
    try {
      fn({ ...status });
    } catch {
      // 表示の失敗は無視する
    }
  }
}

export function isLoggedIn(settings) {
  return !!(settings && settings.authToken && settings.authUser && workerBase(settings.workerUrl));
}

// ---- 通信 ----

/** Worker に問い合わせる。戻り値 { ok: true, data } か { ok: false, reason, status? } */
export async function api(settings, path, { method = 'POST', body, token = settings.authToken, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const base = workerBase(settings.workerUrl);
  if (!settings.workerUrl) return { ok: false, reason: 'not_configured' };
  if (!base) return { ok: false, reason: 'bad_url' };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, reason: 'offline' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, {
      method, headers, body: method === 'POST' ? JSON.stringify(body || {}) : undefined, signal: ctrl.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) return { ok: false, reason: (data && data.error) || 'http', status: res.status };
    return { ok: true, data };
  } catch {
    return { ok: false, reason: ctrl.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(t);
  }
}

export function errorText(r) {
  return r && !r.ok ? syncErrorText(r.reason, r.status) : '';
}

function deviceName() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/iPad|Macintosh.*Mobile|Macintosh.*Safari/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  return 'ブラウザ';
}

// ---- ログイン ----

async function afterLogin(app, data) {
  const state = await db.getSyncState();
  const base = workerBase(app.settings.workerUrl);
  // 別の Worker に切り替えたときは、最初から受け取り直す
  if (state.base !== base) await db.putSyncState({ cursor: 0, base, lastSyncAt: null });
  await app.saveSettings({ ...app.settings, authToken: data.token, authUser: data.user });
  // この端末の記録を共有に送る（デモ試合は除く）。部員（見るだけ）は送らない
  if (!isViewer(app.settings)) await db.queueEverything();
  return syncNow({ force: true });
}

export async function login(app, loginId, password) {
  const r = await api(app.settings, '/basket/auth/login', { body: { loginId, password, device: deviceName() }, token: '' });
  if (!r.ok) return r;
  await afterLogin(app, r.data);
  return { ok: true };
}

export async function setupAdmin(app, { loginId, displayName, password, setupPass }) {
  const r = await api(app.settings, '/basket/auth/setup', { body: { loginId, displayName, password, setupPass, device: deviceName() }, token: '' });
  if (!r.ok) return r;
  await afterLogin(app, r.data);
  return { ok: true };
}

export async function logout(app) {
  // 送っていない記録があっても、端末の中には残る（次にログインしたときに送る）
  await api(app.settings, '/basket/auth/logout').catch(() => null);
  await app.saveSettings({ ...app.settings, authToken: '', authUser: null });
  emit({ state: 'idle', error: '' });
}

export function changePassword(app, current, next) {
  return api(app.settings, '/basket/auth/password', { body: { current, next } });
}

export function listUsers(app) {
  return api(app.settings, '/basket/users', { method: 'GET' });
}

export function createUser(app, user) {
  return api(app.settings, '/basket/users', { body: user });
}

export function updateUser(app, patch) {
  return api(app.settings, '/basket/users/update', { body: patch });
}

export function deleteUser(app, id) {
  return api(app.settings, '/basket/users/delete', { body: { id } });
}

// ---- 同期 ----

async function refreshPending() {
  try {
    emit({ pending: await db.countOutbox() });
  } catch {
    // 数えられなくても続ける
  }
}

/**
 * 同期する。opts.force なら間隔を気にせずすぐ。
 * 戻り値 { ok, received, sent } か { ok: false, reason }
 */
export function syncNow(opts = {}) {
  // 同期の途中で頼まれたら（途中で記録を変えたときなど）、終わったあとにもう1回する
  if (running) {
    if (!queued) {
      queued = running.then(() => {
        queued = null;
        return syncNow({ force: true });
      });
    }
    return queued;
  }
  running = runSync(opts).finally(() => {
    running = null;
  });
  return running;
}

async function runSync({ force = false } = {}) {
  const app = appRef;
  if (!app || !isLoggedIn(app.settings)) return { ok: false, reason: 'not_logged_in' };
  const now = Date.now();
  if (!force && now - lastAttempt < SYNC_MIN_INTERVAL_MS) return { ok: false, reason: 'too_soon' };
  lastAttempt = now;
  emit({ state: 'syncing', error: '' });
  let state = await db.getSyncState();
  const base = workerBase(app.settings.workerUrl);
  if (state.base !== base) state = { cursor: 0, base, lastSyncAt: null };
  const total = { received: 0, sent: 0, gotTeam: false, touched: new Set() };
  const fromStart = state.cursor === 0;

  // 送る予定がなくなり、受け取るものもなくなるまで（多くても20回）
  async function rounds() {
    for (let round = 0; round < 20; round++) {
      // 部員（見るだけ）の端末は送らない（送る予定は捨てる。Worker も受け付けない）
      if (isViewer(app.settings)) await db.removeOutbox(await db.listOutbox());
      const entries = await db.listOutbox();
      // チームの設定は、保存されている値から送る
      const records = { ...(await db.recordsFor(entries)), settings: await db.getSettings() };
      const { push, sent: sentEntries, skipped } = buildPush(entries, records);
      if (skipped.length) await db.removeOutbox(skipped);
      const r = await api(app.settings, '/basket/sync', { body: { cursor: state.cursor, push } });
      if (!r.ok) return r;
      await db.removeOutbox(sentEntries);
      total.sent += sentEntries.length;
      const pending = new Set((await db.listOutbox()).map((en) => en.key));
      const plan = planApply(r.data.items, pending);
      if (r.data.items.some((it) => it.t === 's')) total.gotTeam = true;
      for (const id of await db.applyRemote(plan)) total.touched.add(id);
      // AI の結果を管理者だけに渡す Worker なら、管理者でないこの端末に残っている AI の結果を消す
      if (r.data.aiPolicy === 'admin_only' && !canUseAi(app.settings)) await db.stripAiLocal();
      total.received += r.data.items.length;
      if (plan.team) app.settings = await db.getSettings();
      state = { cursor: r.data.cursor, base, lastSyncAt: Date.now() };
      await db.putSyncState(state);
      const left = await db.countOutbox();
      if (!r.data.more && (left === 0 || sentEntries.length === 0)) break;
    }
    return { ok: true };
  }

  let r = await rounds();
  // 最初から受け取ったのに共有にチームの設定がなければ（最初の端末）、この端末の設定を送る
  if (r.ok && fromStart && !total.gotTeam && !isViewer(app.settings)) {
    await db.queueTeamSettings();
    r = await rounds();
  }
  await refreshPending();
  if (!r.ok) {
    if (r.reason === 'unauthorized') await app.saveSettings({ ...app.settings, authToken: '', authUser: null });
    emit({ state: r.reason === 'offline' ? 'offline' : 'error', error: errorText(r) });
    return r;
  }
  emit({ state: 'idle', lastSyncAt: state.lastSyncAt, error: '', received: total.received });
  if (total.touched.size && app.onRemoteChange) app.onRemoteChange(total.touched);
  return { ok: true, received: total.received, sent: total.sent };
}

/** 端末で記録を変えたとき：少しまとめてから同期する */
function scheduleSync() {
  refreshPending();
  if (!appRef || !isLoggedIn(appRef.settings)) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow({ force: true }), SYNC_DEBOUNCE_MS);
}

/** 起動時に1回呼ぶ */
export async function startSync(app) {
  appRef = app;
  db.setChangeListener(scheduleSync);
  const state = await db.getSyncState().catch(() => null);
  emit({ lastSyncAt: state ? state.lastSyncAt : null });
  refreshPending();
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => syncNow({ force: true }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncNow();
      // 画面を閉じる前に、送っていない記録を送っておく
      if (document.visibilityState === 'hidden' && status.pending > 0) syncNow({ force: true });
    });
  }
  if (isLoggedIn(app.settings)) syncNow({ force: true });
}

export function statusText(s, settings) {
  if (!isLoggedIn(settings)) return '';
  const time = s.lastSyncAt ? new Date(s.lastSyncAt) : null;
  const at = time ? `${time.getMonth() + 1}/${time.getDate()} ${time.getHours()}:${String(time.getMinutes()).padStart(2, '0')}` : '';
  if (s.state === 'syncing') return '同期しています…';
  const pending = s.pending ? `送っていない変更 ${s.pending}件` : '';
  if (s.state === 'offline') return ['電波がありません（つながったら自動で同期）', pending].filter(Boolean).join('　');
  if (s.state === 'error') return ['同期できませんでした', s.error, pending].filter(Boolean).join('　');
  return [at ? `${at} に同期済み` : 'まだ同期していません', pending].filter(Boolean).join('　');
}
