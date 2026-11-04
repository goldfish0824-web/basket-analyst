// アプリの更新：新しい版を見つけたら知らせる。
// ホーム画面から開いたアプリは、閉じずに裏で待機したまま再開されることが多く、
// そのままだと新しい版を受け取っても画面が古いままになる。そこで、
//  ・前面に出たときに新しい版を確かめる（1分に1回まで）
//  ・新しい版になったら、ホーム画面では自動で読み込み直し、ほかの画面では「更新する」ボタンを出す
//    （記録の途中で勝手に読み込み直さないため）
import { h } from './ui.js';

const CHECK_INTERVAL_MS = 60 * 1000;

let registration = null;
let lastCheck = 0;
let updateReady = false;
let hadController = false;
const waiters = new Set();

export function isUpdateReady() {
  return updateReady;
}

/** 起動時に1回呼ぶ */
export function registerUpdates() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || location.protocol === 'file:') return;
  hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    registration = reg;
  }).catch((err) => {
    console.warn('Service Worker を登録できません', err);
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 初めて入れたとき（前の版がない）は知らせない
    if (!hadController) {
      hadController = true;
      return;
    }
    updateReady = true;
    for (const w of waiters) w();
    waiters.clear();
    if (document.body.dataset.view === 'home') location.reload();
    else showBanner();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
  window.addEventListener('pageshow', () => checkForUpdate());
}

/** 新しい版があるか確かめる（force でなければ1分に1回まで） */
export async function checkForUpdate(force = false) {
  if (!registration) return;
  const now = Date.now();
  if (!force && now - lastCheck < CHECK_INTERVAL_MS) return;
  lastCheck = now;
  try {
    await registration.update();
  } catch {
    // 電波がないときなど。次の機会に確かめる
  }
}

/**
 * 設定画面の「最新の版を確かめる」。戻り値は 'updated'（新しい版になった）／'latest'（最新）／'unavailable'
 */
export async function checkNow(timeoutMs = 15000) {
  if (!registration) return 'unavailable';
  if (updateReady) return 'updated';
  const changed = new Promise((resolve) => {
    const done = () => resolve('updated');
    waiters.add(done);
    setTimeout(() => {
      waiters.delete(done);
      resolve('latest');
    }, timeoutMs);
  });
  await checkForUpdate(true);
  // 新しい版がなければ、すぐ「最新」と答える
  if (!registration.installing && !registration.waiting && !updateReady) return 'latest';
  return changed;
}

/** いま動いている版（Service Worker のキャッシュの版）。わからなければ null */
export function getVersion() {
  return new Promise((resolve) => {
    const c = typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!c) {
      resolve(null);
      return;
    }
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 1500);
    ch.port1.onmessage = (ev) => {
      clearTimeout(timer);
      resolve((ev.data && ev.data.version) || null);
    };
    c.postMessage({ type: 'version' }, [ch.port2]);
  });
}

function showBanner() {
  if (document.getElementById('update-banner')) return;
  const bar = h('div', { id: 'update-banner', class: 'update-banner', role: 'status' },
    h('span', { class: 'update-text' }, '新しい版になりました。記録は消えません。'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, '更新する'),
    h('button', { class: 'btn', type: 'button', onclick: () => bar.remove() }, 'あとで'));
  document.body.appendChild(bar);
}
