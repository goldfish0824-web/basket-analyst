// 場面別Q&A：よくある場面と対処の例（一般的な考え方の下書き。チームの方針は主顧問と決めてメモに残す）
import { h, replace, icon } from '../ui.js';
import { QA_ITEMS, QA_CATEGORIES, CATEGORY_LABEL, searchQa, countByCategory } from '../qa.js';
import { renderDiagram } from './diagram.js';

function sessionGet(k) {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}
function sessionSet(k, v) {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    // 保存できなくても動く
  }
}

function favorites(app) {
  return Array.isArray(app.settings.qaFavorites) ? app.settings.qaFavorites : [];
}

async function toggleFavorite(app, id) {
  const fav = favorites(app);
  const next = fav.includes(id) ? fav.filter((x) => x !== id) : [...fav, id];
  await app.saveSettings({ ...app.settings, qaFavorites: next });
  return next.includes(id);
}

const NOTE = '一般的な考え方の例です（下書き）。チームとしての方針は主顧問と相談して決め、各場面の「チームのメモ」に残してください。';

/** 一覧 */
export async function renderQaList(root, params, app) {
  const state = {
    query: sessionGet('qaQuery') || '',
    category: sessionGet('qaCategory') || 'all',
  };
  const counts = countByCategory(QA_ITEMS);
  const chips = h('div', { class: 'qa-chips', role: 'group', 'aria-label': 'カテゴリ' });
  const grid = h('div', { class: 'qa-grid' });
  const countEl = h('span', { class: 'qa-count' });
  const search = h('input', {
    type: 'search', class: 'qa-search', value: state.query, placeholder: 'キーワード（例：プレス、ゾーン、リバウンド）',
    'aria-label': 'キーワードで探す', autocomplete: 'off',
    oninput: (ev) => {
      state.query = ev.target.value;
      sessionSet('qaQuery', state.query);
      draw();
    },
  });

  function chip(key, label, n) {
    return h('button', {
      class: ['qa-chip', state.category === key && 'on'], type: 'button', 'aria-pressed': String(state.category === key),
      onclick: () => {
        state.category = key;
        sessionSet('qaCategory', key);
        draw();
      },
    }, label, h('span', { class: 'qa-chip-n' }, n));
  }

  function draw() {
    const fav = favorites(app);
    replace(chips,
      chip('all', 'すべて', QA_ITEMS.length),
      chip('fav', '★ お気に入り', fav.length),
      QA_CATEGORIES.map((c) => chip(c.key, c.label, counts[c.key])));
    const list = searchQa(QA_ITEMS, { query: state.query, category: state.category, favorites: fav });
    countEl.textContent = `${list.length}件`;
    if (!list.length) {
      replace(grid, h('p', { class: 'muted qa-empty' }, state.category === 'fav' ? 'お気に入りはまだありません。各場面の「★」で登録できます。' : '当てはまる場面がありません。'));
      return;
    }
    replace(grid, list.map((it) => {
      const note = (app.settings.qaNotes || {})[it.id];
      return h('a', { class: 'qa-card', href: `#/qa/${it.id}` },
        h('div', { class: 'qa-card-body' },
          h('div', { class: 'qa-card-top' },
            h('span', { class: 'qa-cat' }, CATEGORY_LABEL[it.cat]),
            fav.includes(it.id) ? h('span', { class: 'qa-star on', 'aria-label': 'お気に入り' }, '★') : null,
            note ? h('span', { class: 'qa-has-note' }, 'メモあり') : null),
          h('h3', { class: 'qa-title' }, it.title),
          h('p', { class: 'qa-situation' }, it.situation)),
        it.diagram ? h('div', { class: 'qa-thumb' }, renderDiagram(it.diagram, { thumb: true, caption: it.caption })) : null);
    }));
  }
  draw();

  root.append(
    h('header', { class: 'page-head' },
      h('a', { class: 'btn', href: '#/' }, icon('home'), 'ホーム'),
      h('div', { class: 'head-title' }, h('h1', null, '場面別Q&A'), h('span', { class: 'muted' }, 'よくある場面と対処の例')),
      h('div', { class: 'head-actions' })),
    h('div', { class: 'page wide' },
      h('p', { class: 'qa-note' }, NOTE),
      h('div', { class: 'qa-toolbar' }, search, countEl),
      chips,
      grid),
  );
}

/** 1つの場面 */
export async function renderQaDetail(root, params, app) {
  const index = QA_ITEMS.findIndex((it) => it.id === params.id);
  if (index < 0) {
    app.go('#/qa');
    return undefined;
  }
  const it = QA_ITEMS[index];
  const prev = QA_ITEMS[index - 1];
  const next = QA_ITEMS[index + 1];

  const star = h('button', { class: 'btn qa-fav', type: 'button' });
  const drawStar = () => {
    const on = favorites(app).includes(it.id);
    replace(star, h('span', { class: ['qa-star', on && 'on'] }, on ? '★' : '☆'), on ? 'お気に入り' : 'お気に入りに追加');
    star.setAttribute('aria-pressed', String(on));
  };
  star.addEventListener('click', async () => {
    await toggleFavorite(app, it.id);
    drawStar();
  });
  drawStar();

  const saved = h('span', { class: 'qa-saved muted', 'aria-live': 'polite' });
  let timer = null;
  let pending = null;
  const saveMemo = async (value) => {
    pending = null;
    const notes = { ...(app.settings.qaNotes || {}) };
    if (value.trim()) notes[it.id] = value;
    else delete notes[it.id];
    await app.saveSettings({ ...app.settings, qaNotes: notes });
    saved.textContent = '保存しました';
  };
  const memo = h('textarea', {
    class: 'qa-memo', rows: '4', maxlength: '1000', placeholder: '主顧問と決めたこと、練習で確かめたことなど',
    'aria-label': 'チームのメモ',
    oninput: (ev) => {
      clearTimeout(timer);
      saved.textContent = '';
      pending = ev.target.value;
      timer = setTimeout(() => saveMemo(pending), 600);
    },
  });
  memo.value = (app.settings.qaNotes || {})[it.id] || '';

  const text = h('div', { class: 'qa-text' },
    h('section', { class: 'card' },
      h('h2', null, '状況'),
      h('p', { class: 'qa-situation-full' }, it.situation)),
    h('section', { class: 'card' },
      h('h2', null, '対処の例'),
      h('ol', { class: 'qa-points' }, it.points.map((p) => h('li', null, p)))),
    it.watch && it.watch.length
      ? h('section', { class: 'card' },
        h('h2', null, 'アプリで見る数字'),
        h('ul', { class: 'qa-watch' }, it.watch.map((w) => h('li', null, icon('chart'), w))))
      : null,
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'チームのメモ'), saved),
      memo,
      h('p', { class: 'field-note' }, 'この iPad に保存し、全データのバックアップにも入ります。')));

  root.append(
    h('header', { class: 'page-head' },
      h('a', { class: 'btn', href: '#/qa' }, icon('back'), '一覧'),
      h('div', { class: 'head-title' },
        h('span', { class: 'muted' }, CATEGORY_LABEL[it.cat]),
        h('h1', null, it.title)),
      h('div', { class: 'head-actions' }, star)),
    h('div', { class: 'page wide' },
      h('div', { class: ['qa-detail', it.diagram && `has-diagram ${it.diagram.court}`] },
        it.diagram ? h('section', { class: 'card qa-diagram' }, renderDiagram(it.diagram, { caption: it.caption })) : null,
        text),
      h('p', { class: 'qa-note' }, NOTE),
      h('nav', { class: 'qa-nav' },
        prev ? h('a', { class: 'btn', href: `#/qa/${prev.id}` }, icon('back'), prev.title) : h('span'),
        next ? h('a', { class: 'btn', href: `#/qa/${next.id}` }, next.title, h('span', { class: 'flip' }, icon('back'))) : h('span'))),
  );
  // 画面を離れるときは、入力途中のメモをすぐ保存する
  return () => {
    clearTimeout(timer);
    if (pending != null) saveMemo(pending);
  };
}
