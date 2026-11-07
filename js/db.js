// 端末内の保存（IndexedDB）。1イベントごとに書き込む。
// 記録の共有（同期）のため、試合・記録・チームの設定を変えたら「送る予定」（outbox）に1件入れる（sync-core.js 参照）。
import { DEFAULT_DEFENSES } from './model.js';
import { outboxKey, teamSettingsChanged, isDemoGame } from './sync-core.js';

const DB_NAME = 'basket-analyst';
const DB_VERSION = 2;

let changeListener = null;
/** 端末で記録を変えたときに呼ぶ関数（同期の予約に使う） */
export function setChangeListener(fn) {
  changeListener = fn;
}
function changed() {
  if (changeListener) {
    try {
      changeListener();
    } catch {
      // 同期の予約に失敗しても保存は終わっている
    }
  }
}

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('games')) db.createObjectStore('games', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('events')) {
        const s = db.createObjectStore('events', { keyPath: 'id' });
        s.createIndex('gameId', 'gameId', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      // 送る予定（記録の共有）
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // 別のタブで版が上がったときは閉じて開き直せるようにする
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('データベースを開けません。ほかのタブを閉じてください。'));
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('保存できませんでした'));
    tx.onerror = () => reject(tx.error || new Error('保存できませんでした'));
  });
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- 試合 ----

export async function listGames() {
  const db = await open();
  return reqP(db.transaction('games').objectStore('games').getAll());
}

export async function getGame(id) {
  const db = await open();
  return reqP(db.transaction('games').objectStore('games').get(id));
}

function queueGame(tx, id, stamp) {
  tx.objectStore('outbox').put({ key: outboxKey.game(id), kind: 'game', id, stamp });
}
function queueEvent(tx, id, gameId, stamp) {
  tx.objectStore('outbox').put({ key: outboxKey.event(id), kind: 'event', id, gameId, stamp });
}

export async function putGame(game) {
  const db = await open();
  const tx = db.transaction(['games', 'outbox'], 'readwrite');
  const now = Date.now();
  tx.objectStore('games').put({ ...game, updatedAt: now });
  queueGame(tx, game.id, now);
  await done(tx);
  changed();
}

export async function deleteGame(id) {
  const db = await open();
  const tx = db.transaction(['games', 'events', 'outbox'], 'readwrite');
  const now = Date.now();
  tx.objectStore('games').delete(id);
  queueGame(tx, id, now);
  const idx = tx.objectStore('events').index('gameId');
  idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (ev) => {
    const cur = ev.target.result;
    if (!cur) return;
    tx.objectStore('events').delete(cur.primaryKey);
    queueEvent(tx, cur.primaryKey, id, now);
    cur.continue();
  };
  await done(tx);
  changed();
}

// ---- イベント ----

export async function listEvents(gameId) {
  const db = await open();
  const all = await reqP(db.transaction('events').objectStore('events').index('gameId').getAll(IDBKeyRange.only(gameId)));
  return all.sort((a, b) => a.seq - b.seq);
}

export async function listAllEvents() {
  const db = await open();
  const all = await reqP(db.transaction('events').objectStore('events').getAll());
  return all.sort((a, b) => (a.gameId === b.gameId ? a.seq - b.seq : a.gameId.localeCompare(b.gameId)));
}

export async function putEvent(event) {
  const db = await open();
  const tx = db.transaction(['events', 'outbox'], 'readwrite');
  const now = Date.now();
  tx.objectStore('events').put({ ...event, updatedAt: now });
  queueEvent(tx, event.id, event.gameId, now);
  await done(tx);
  changed();
}

export async function deleteEvent(id) {
  const db = await open();
  const tx = db.transaction(['events', 'outbox'], 'readwrite');
  const store = tx.objectStore('events');
  const now = Date.now();
  store.get(id).onsuccess = (ev) => {
    const e = ev.target.result;
    store.delete(id);
    if (e) queueEvent(tx, id, e.gameId, now);
  };
  await done(tx);
  changed();
}

/** 試合とイベントをまとめて書き込む（デモ作成・読み込み用）。同じ試合の古いイベントは消す。 */
export async function replaceGames(games, events) {
  const db = await open();
  const now = Date.now();
  const tx = db.transaction(['games', 'events', 'outbox'], 'readwrite');
  const gs = tx.objectStore('games');
  const es = tx.objectStore('events');
  const idx = es.index('gameId');
  for (const g of games) {
    gs.put({ ...g, updatedAt: now });
    queueGame(tx, g.id, now);
    idx.openKeyCursor(IDBKeyRange.only(g.id)).onsuccess = (ev) => {
      const cur = ev.target.result;
      if (!cur) return;
      es.delete(cur.primaryKey);
      queueEvent(tx, cur.primaryKey, g.id, now);
      cur.continue();
    };
  }
  await done(tx);
  const tx2 = db.transaction(['events', 'outbox'], 'readwrite');
  for (const e of events) {
    tx2.objectStore('events').put({ ...e, updatedAt: now });
    queueEvent(tx2, e.id, e.gameId, now);
  }
  await done(tx2);
  changed();
}

// ---- 記録の共有（同期） ----

export async function listOutbox() {
  const db = await open();
  return reqP(db.transaction('outbox').objectStore('outbox').getAll());
}

export async function countOutbox() {
  const db = await open();
  return reqP(db.transaction('outbox').objectStore('outbox').count());
}

/** 送り終えたものを消す（送ったあとに端末で変えたもの＝stamp が新しいものは残す） */
export async function removeOutbox(entries) {
  if (!entries.length) return;
  const db = await open();
  const tx = db.transaction('outbox', 'readwrite');
  const store = tx.objectStore('outbox');
  for (const en of entries) {
    store.get(en.key).onsuccess = (ev) => {
      const cur = ev.target.result;
      if (cur && cur.stamp <= en.stamp) store.delete(en.key);
    };
  }
  await done(tx);
}

/** 送る予定の記録を読む（{ games: Map, events: Map }） */
export async function recordsFor(entries) {
  const db = await open();
  const tx = db.transaction(['games', 'events']);
  const games = new Map();
  const events = new Map();
  const gameIds = new Set();
  for (const en of entries) {
    if (en.kind === 'game') gameIds.add(en.id);
    if (en.kind === 'event') {
      tx.objectStore('events').get(en.id).onsuccess = (ev) => {
        const e = ev.target.result;
        if (e) events.set(e.id, e);
      };
      if (en.gameId) gameIds.add(en.gameId);
    }
  }
  for (const id of gameIds) {
    tx.objectStore('games').get(id).onsuccess = (ev) => {
      const g = ev.target.result;
      if (g) games.set(g.id, g);
    };
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return { games, events };
}

/**
 * ログインしたとき：端末の記録をすべて送る予定に入れる（デモ試合は除く）。
 * チームの設定は入れない（新しい端末の初期値で、共有の設定を上書きしないため。queueTeamSettings を参照）
 */
export async function queueEverything() {
  const db = await open();
  const now = Date.now();
  const games = await listGames();
  const demo = new Set(games.filter(isDemoGame).map((g) => g.id));
  const events = await listAllEvents();
  const tx = db.transaction('outbox', 'readwrite');
  for (const g of games) if (!demo.has(g.id)) queueGame(tx, g.id, g.updatedAt || now);
  for (const e of events) if (!demo.has(e.gameId)) queueEvent(tx, e.id, e.gameId, e.updatedAt || e.ts || now);
  await done(tx);
  changed();
}

/** チームの設定を送る予定に入れる（共有にまだチームの設定がないとき＝最初の端末だけ） */
export async function queueTeamSettings() {
  const db = await open();
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').put({ key: outboxKey.team(), kind: 'team', id: 'settings', stamp: Date.now() });
  await done(tx);
  changed();
}

/**
 * 共有から受け取ったものを反映する（送る予定には入れない）。
 * plan は sync-core.js の planApply の結果。反映の直前にも、送る予定が残っているものは上書きしない。
 * 戻り値：反映した試合の ID の Set
 */
export async function applyRemote(plan) {
  const db = await open();
  const tx = db.transaction(['games', 'events', 'settings', 'outbox'], 'readwrite');
  const touched = new Set();
  tx.objectStore('outbox').getAllKeys().onsuccess = (ev) => {
    const pending = new Set(ev.target.result);
    const gs = tx.objectStore('games');
    const es = tx.objectStore('events');
    for (const g of plan.putGames) {
      if (pending.has(outboxKey.game(g.id))) continue;
      gs.put(g);
      touched.add(g.id);
    }
    for (const e of plan.putEvents) {
      if (pending.has(outboxKey.event(e.id))) continue;
      es.put(e);
      touched.add(e.gameId);
    }
    for (const id of plan.deleteEvents) {
      if (pending.has(outboxKey.event(id))) continue;
      es.get(id).onsuccess = (r) => {
        if (r.target.result) touched.add(r.target.result.gameId);
        es.delete(id);
      };
    }
    for (const id of plan.deleteGames) {
      if (pending.has(outboxKey.game(id))) continue;
      gs.delete(id);
      touched.add(id);
      es.index('gameId').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (r) => {
        const cur = r.target.result;
        if (!cur) return;
        es.delete(cur.primaryKey);
        cur.continue();
      };
    }
    if (plan.team && !pending.has(outboxKey.team())) {
      const ss = tx.objectStore('settings');
      ss.get('app').onsuccess = (r) => {
        const row = r.target.result;
        ss.put({ key: 'app', value: { ...(row ? row.value : {}), ...plan.team } });
      };
    }
  };
  await done(tx);
  return touched;
}

/** 同期の状態（どこまで受け取ったか など）。端末ごと */
export async function getSyncState() {
  const db = await open();
  const row = await reqP(db.transaction('settings').objectStore('settings').get('sync'));
  return row ? row.value : { cursor: 0, base: null, lastSyncAt: null };
}

export async function putSyncState(state) {
  const db = await open();
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put({ key: 'sync', value: state });
  await done(tx);
}

// ---- 設定 ----

export const DEFAULT_SETTINGS = {
  rosterTemplate: [],
  defenses: DEFAULT_DEFENSES,
  installHintDismissed: false,
  lastBackupAt: null,
  checklistTemplate: [],
  rewindSec: 8,
  // 試合時計（端末ごと）：クォーターと延長の長さ（分）、新しい試合の時計の進め方（clock.js の CLOCK_MODES）
  quarterMin: 10,
  otMin: 5,
  clockMode: '',
  clockLast2Official: true,
  // アシストを記録するか（端末ごと。既定は記録しない。1人で記録するときの負担を減らすため）
  recordAssists: false,
  // AI に伝えない項目（記録し忘れが多い項目。チームで共有）：リバウンド、自チームの守備隊形、相手の守備隊形
  aiExclude: { rebounds: false, usDefense: false, oppDefense: false },
  // 場面別Q&A のお気に入りとチームのメモ
  qaFavorites: [],
  qaNotes: {},
  // 画面の配色（端末ごと）：'dark'（既定）／'light'
  theme: 'dark',
  // AI接続（端末の中だけに保存。バックアップのファイルには入れない）
  workerUrl: '',
  staffPass: '',
  // 記録の共有（ログイン）。端末の中だけに保存し、バックアップのファイルには入れない
  authToken: '',
  authUser: null,
};

/** 保存した設定に初期値を合わせる */
export function normalizeSettings(value) {
  const s = { ...DEFAULT_SETTINGS, ...(value || {}) };
  if (!Array.isArray(s.defenses) || s.defenses.length === 0) s.defenses = [...DEFAULT_DEFENSES];
  if (!Array.isArray(s.rosterTemplate)) s.rosterTemplate = [];
  if (!Array.isArray(s.checklistTemplate)) s.checklistTemplate = [];
  if (!s.aiExclude || typeof s.aiExclude !== 'object') s.aiExclude = { ...DEFAULT_SETTINGS.aiExclude };
  return s;
}

export async function getSettings() {
  const db = await open();
  const row = await reqP(db.transaction('settings').objectStore('settings').get('app'));
  return normalizeSettings(row ? row.value : {});
}

export async function putSettings(settings) {
  const db = await open();
  const tx = db.transaction(['settings', 'outbox'], 'readwrite');
  const store = tx.objectStore('settings');
  let teamChanged = false;
  store.get('app').onsuccess = (ev) => {
    // 保存前の値は、初期値と合わせた「画面で使っていた値」で比べる（はじめて保存した端末の初期値を、変更として送らないため）
    const before = normalizeSettings(ev.target.result ? ev.target.result.value : {});
    store.put({ key: 'app', value: settings });
    // 共有する設定（名簿のひな形・守備隊形・チェック項目・巻き戻し秒数・Q&A のメモ）が変わったら送る
    if (teamSettingsChanged(before, settings)) {
      teamChanged = true;
      tx.objectStore('outbox').put({ key: outboxKey.team(), kind: 'team', id: 'settings', stamp: Date.now() });
    }
  };
  await done(tx);
  if (teamChanged) changed();
}

/** 端末の保存領域を消されにくくする（対応ブラウザのみ） */
export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch {
    // 対応していなければ何もしない
  }
  return false;
}
