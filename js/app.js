// 画面の切り替え（#/ … のハッシュで）と起動処理。
import * as db from './db.js';
import { h, replace, toast, applyTheme } from './ui.js';
import { renderHome } from './views/home.js';
import { renderSetup } from './views/setup.js';
import { renderRecord } from './views/record.js';
import { renderSummary } from './views/summary.js';
import { renderSettings } from './views/settings.js';
import { renderQuarter } from './views/quarter.js';
import { renderReview } from './views/review.js';

const root = document.getElementById('app');

const app = {
  settings: null,
  async saveSettings(next) {
    app.settings = next;
    applyTheme(next.theme);
    await db.putSettings(next);
  },
  go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  },
};

let cleanup = null;

function parse(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { view: 'home' };
  if (parts[0] === 'new') return { view: 'setup', gameId: null };
  if (parts[0] === 'settings') return { view: 'settings' };
  if (parts[0] === 'game' && parts[1]) {
    const sub = parts[2] || 'record';
    if (sub === 'record') return { view: 'record', gameId: parts[1] };
    if (sub === 'summary') return { view: 'summary', gameId: parts[1] };
    if (sub === 'edit') return { view: 'setup', gameId: parts[1] };
    if (sub === 'review') return { view: 'review', gameId: parts[1] };
    if (sub === 'quarter' && parts[3]) return { view: 'quarter', gameId: parts[1], quarter: parts[3] };
  }
  return { view: 'home' };
}

const VIEWS = {
  home: renderHome,
  setup: renderSetup,
  record: renderRecord,
  summary: renderSummary,
  settings: renderSettings,
  quarter: renderQuarter,
  review: renderReview,
};

async function route() {
  if (cleanup) {
    try {
      cleanup();
    } catch {
      // 前の画面の後片付けに失敗しても次へ進む
    }
    cleanup = null;
  }
  document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
  const params = parse(location.hash);
  document.body.dataset.view = params.view;
  const container = h('div', { class: `view view-${params.view}` });
  replace(root, container);
  window.scrollTo(0, 0);
  try {
    const r = await VIEWS[params.view](container, params, app);
    if (typeof r === 'function') cleanup = r;
  } catch (err) {
    console.error(err);
    replace(
      container,
      h('div', { class: 'page' },
        h('h1', null, 'エラーが起きました'),
        h('p', null, String((err && err.message) || err)),
        h('a', { class: 'btn primary', href: '#/' }, 'ホームへ')),
    );
  }
}

async function start() {
  try {
    app.settings = await db.getSettings();
  } catch (err) {
    replace(root, h('div', { class: 'page' },
      h('h1', null, '端末に保存できません'),
      h('p', null, 'プライベートブラウズでは保存できません。通常のタブで開くか、ホーム画面に追加して開いてください。'),
      h('p', { class: 'muted' }, String((err && err.message) || err))));
    return;
  }
  applyTheme(app.settings.theme);
  db.requestPersist();
  window.addEventListener('hashchange', route);
  await route();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service Worker を登録できません', err);
    });
  }
  window.addEventListener('offline', () => toast('オフラインです（記録・集計はそのまま使えます）'));
}

start();
