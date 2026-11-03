// 端末内の保存（IndexedDB）。1イベントごとに書き込む。
import { DEFAULT_DEFENSES } from './model.js';

const DB_NAME = 'basket-analyst';
const DB_VERSION = 1;

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

export async function putGame(game) {
  const db = await open();
  const tx = db.transaction('games', 'readwrite');
  tx.objectStore('games').put({ ...game, updatedAt: Date.now() });
  await done(tx);
}

export async function deleteGame(id) {
  const db = await open();
  const tx = db.transaction(['games', 'events'], 'readwrite');
  tx.objectStore('games').delete(id);
  const idx = tx.objectStore('events').index('gameId');
  idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (ev) => {
    const cur = ev.target.result;
    if (!cur) return;
    tx.objectStore('events').delete(cur.primaryKey);
    cur.continue();
  };
  await done(tx);
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
  const tx = db.transaction('events', 'readwrite');
  tx.objectStore('events').put(event);
  await done(tx);
}

export async function deleteEvent(id) {
  const db = await open();
  const tx = db.transaction('events', 'readwrite');
  tx.objectStore('events').delete(id);
  await done(tx);
}

/** 試合とイベントをまとめて書き込む（デモ作成・読み込み用）。同じ試合の古いイベントは消す。 */
export async function replaceGames(games, events) {
  const db = await open();
  const tx = db.transaction(['games', 'events'], 'readwrite');
  const gs = tx.objectStore('games');
  const es = tx.objectStore('events');
  const idx = es.index('gameId');
  for (const g of games) {
    gs.put(g);
    idx.openKeyCursor(IDBKeyRange.only(g.id)).onsuccess = (ev) => {
      const cur = ev.target.result;
      if (!cur) return;
      es.delete(cur.primaryKey);
      cur.continue();
    };
  }
  await done(tx);
  const tx2 = db.transaction('events', 'readwrite');
  for (const e of events) tx2.objectStore('events').put(e);
  await done(tx2);
}

// ---- 設定 ----

export const DEFAULT_SETTINGS = {
  rosterTemplate: [],
  defenses: DEFAULT_DEFENSES,
  installHintDismissed: false,
  lastBackupAt: null,
  checklistTemplate: [],
  rewindSec: 8,
  // 場面別Q&A のお気に入りとチームのメモ
  qaFavorites: [],
  qaNotes: {},
  // 画面の配色（端末ごと）：'dark'（既定）／'light'
  theme: 'dark',
  // AI接続（端末の中だけに保存。バックアップのファイルには入れない）
  workerUrl: '',
  staffPass: '',
};

export async function getSettings() {
  const db = await open();
  const row = await reqP(db.transaction('settings').objectStore('settings').get('app'));
  const s = { ...DEFAULT_SETTINGS, ...(row ? row.value : {}) };
  if (!Array.isArray(s.defenses) || s.defenses.length === 0) s.defenses = [...DEFAULT_DEFENSES];
  if (!Array.isArray(s.rosterTemplate)) s.rosterTemplate = [];
  if (!Array.isArray(s.checklistTemplate)) s.checklistTemplate = [];
  return s;
}

export async function putSettings(settings) {
  const db = await open();
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put({ key: 'app', value: settings });
  await done(tx);
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
