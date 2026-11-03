// 場面別Q&A：よくある場面と対処の例（一般的な考え方の下書き。チームの方針は主顧問と決めてメモに残す）
import { h, replace, icon } from '../ui.js';
import {
  QA_ITEMS, QA_CATEGORIES, CATEGORY_LABEL, searchQa, countByCategory, itemDiagrams, unitDiagrams, patternLabel, resolveQaId,
  mirrorItem,
} from '../qa.js';
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
      const first = itemDiagrams(it)[0];
      return h('a', { class: 'qa-card', href: `#/qa/${it.id}` },
        h('div', { class: 'qa-card-body' },
          h('div', { class: 'qa-card-top' },
            h('span', { class: 'qa-cat' }, CATEGORY_LABEL[it.cat]),
            fav.includes(it.id) ? h('span', { class: 'qa-star on', 'aria-label': 'お気に入り' }, '★') : null,
            Array.isArray(it.patterns) ? h('span', { class: 'qa-has-note' }, `${it.patterns.length}パターン`) : null,
            note ? h('span', { class: 'qa-has-note' }, 'メモあり') : null),
          h('h3', { class: 'qa-title' }, it.title),
          h('p', { class: 'qa-situation' }, it.situation)),
        first ? h('div', { class: 'qa-thumb' }, renderDiagram(first.diagram, { thumb: true, caption: first.caption })) : null);
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
    // 整理してまとめた場面の古いリンクは、まとめた先へ
    const moved = resolveQaId(params.id);
    if (moved.id !== params.id && QA_ITEMS.some((it) => it.id === moved.id)) {
      if (moved.pattern != null) sessionSet(`qaPattern:${moved.id}`, String(moved.pattern));
      location.replace(`#/qa/${moved.id}`);
      return undefined;
    }
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

  const memoCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'チームのメモ'), saved),
    memo,
    h('p', { class: 'field-note' }, 'この iPad に保存し、全データのバックアップにも入ります。'));
  const textFor = (view) => h('div', { class: 'qa-text' },
    h('section', { class: 'card' },
      h('h2', null, '状況'),
      h('p', { class: 'qa-situation-full' }, view.situation)),
    h('section', { class: 'card' },
      h('h2', null, Array.isArray(view.patterns) ? 'どのパターンでも' : '対処の例'),
      h('ol', { class: 'qa-points' }, view.points.map((p) => h('li', null, p)))),
    view.watch && view.watch.length
      ? h('section', { class: 'card' },
        h('h2', null, 'アプリで見る数字'),
        h('ul', { class: 'qa-watch' }, view.watch.map((w) => h('li', null, icon('chart'), w))))
      : null,
    memoCard);

  // 左右を反対にする（終盤のセットなど。開いている間だけ覚える）
  const mirrorKey = `qaMirror:${it.id}`;
  let mirrored = it.mirror === true && sessionGet(mirrorKey) === '1';
  const body = h('div');
  const mirrorBtn = it.mirror === true
    ? h('button', {
      class: 'btn qa-mirror', type: 'button',
      onclick: () => {
        mirrored = !mirrored;
        sessionSet(mirrorKey, mirrored ? '1' : '0');
        draw();
      },
    })
    : null;
  function draw() {
    const view = mirrored ? mirrorItem(it) : it;
    if (mirrorBtn) {
      mirrorBtn.classList.toggle('on', mirrored);
      mirrorBtn.setAttribute('aria-pressed', String(mirrored));
      replace(mirrorBtn, icon('swap'), mirrored ? '左右を元に戻す' : '左右を反対にする');
    }
    replace(body, detailBody(view, textFor(view), mirrorBtn, mirrored));
  }
  draw();

  root.append(
    h('header', { class: 'page-head' },
      h('a', { class: 'btn', href: '#/qa' }, icon('back'), '一覧'),
      h('div', { class: 'head-title' },
        h('span', { class: 'muted' }, CATEGORY_LABEL[it.cat]),
        h('h1', null, it.title)),
      h('div', { class: 'head-actions' }, star)),
    h('div', { class: 'page wide' },
      body,
      h('p', { class: 'qa-note' }, NOTE),
      h('nav', { class: 'qa-nav' },
        prev
          ? h('a', { class: 'btn qa-nav-prev', href: `#/qa/${prev.id}`, 'aria-label': `前の場面：${prev.title}` },
            icon('back'), h('span', { class: 'qa-nav-label' }, prev.title))
          : h('span'),
        next
          ? h('a', { class: 'btn qa-nav-next', href: `#/qa/${next.id}`, 'aria-label': `次の場面：${next.title}` },
            h('span', { class: 'qa-nav-label' }, next.title), h('span', { class: 'flip' }, icon('back')))
          : h('span'))),
  );
  // 画面を離れるときは、入力途中のメモをすぐ保存する
  return () => {
    clearTimeout(timer);
    if (pending != null) saveMemo(pending);
  };
}

/** 図の並び方：オールコート1枚／ハーフコート1枚／手順ごとの図 */
function figureKind(diagrams) {
  if (diagrams.length > 1) return 'steps';
  return diagrams[0] && diagrams[0].diagram.court === 'full' ? 'full' : 'half';
}

/** 動きの説明の1行。先頭の①〜⑨は、図の順番の札と同じ見た目の札にする */
function moveItem(text) {
  const m = /^([\u2460-\u2468])(.*)$/u.exec(text);
  if (!m) return h('li', { class: 'plain' }, text);
  const n = m[1].charCodeAt(0) - 0x2460 + 1;
  return h('li', null, h('span', { class: 'qa-move-n', 'aria-label': `順番${n}` }, String(n)), m[2]);
}

/** パターンの切り替え（タブ）と、選んだパターンの図・動き。tool は右上に置くボタン（左右の入れ替え） */
function patternCard(it, tool, mirrored) {
  const key = `qaPattern:${it.id}`;
  const saved = Number(sessionGet(key));
  let current = Number.isInteger(saved) && saved >= 0 && saved < it.patterns.length ? saved : 0;
  const panelId = `qa-pattern-${it.id}`;
  const tabs = it.patterns.map((p, i) => h('button', {
    class: 'qa-ptab', type: 'button', role: 'tab', id: `${panelId}-tab${i}`, 'aria-controls': panelId,
    onclick: () => select(i),
  }, h('span', { class: 'qa-ptab-n' }, patternLabel(i)), h('span', { class: 'qa-ptab-name' }, p.name)));
  const panel = h('div', { class: 'qa-pbody', role: 'tabpanel', id: panelId });

  function select(i) {
    current = i;
    sessionSet(key, String(i));
    tabs.forEach((t, j) => {
      t.classList.toggle('on', j === i);
      t.setAttribute('aria-selected', String(j === i));
      t.tabIndex = j === i ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', `${panelId}-tab${i}`);
    const p = it.patterns[i];
    const diagrams = unitDiagrams(p);
    const kind = figureKind(diagrams);
    replace(panel,
      h('div', { class: ['qa-pgrid', kind] },
        h('div', { class: ['qa-pfigs', kind] }, diagrams.map((d) => h('div', { class: 'qa-step' }, renderDiagram(d.diagram, { caption: d.caption })))),
        h('div', { class: 'qa-pmoves' },
          h('h3', { class: 'qa-pname' }, h('span', { class: 'qa-ptab-n' }, patternLabel(i)), p.name),
          h('ul', { class: 'qa-moves' }, (p.points || []).map(moveItem)))));
  }
  select(current);
  return h('section', { class: ['card qa-patterns', mirrored && 'mirrored'] },
    tool
      ? h('div', { class: 'qa-ptools' },
        mirrored ? h('span', { class: 'qa-mirror-note' }, '左右を反対にして表示しています（図と説明文）') : h('span'),
        tool)
      : null,
    h('div', { class: 'qa-ptabs', role: 'tablist', 'aria-label': 'パターン' }, tabs),
    panel);
}

/** 図と本文の並び：パターンの切り替え／図1枚（ハーフは左右、オールは上下）／手順ごとの図（上に並べる） */
function detailBody(it, text, tool = null, mirrored = false) {
  if (Array.isArray(it.patterns)) {
    return h('div', { class: 'qa-detail has-diagram patterns' }, patternCard(it, tool, mirrored), text);
  }
  const diagrams = itemDiagrams(it);
  if (!diagrams.length) return h('div', { class: 'qa-detail' }, text);
  if (Array.isArray(it.steps)) {
    return h('div', { class: 'qa-detail has-diagram steps' },
      h('section', { class: 'card qa-steps' },
        diagrams.map((d) => h('div', { class: 'qa-step' }, renderDiagram(d.diagram, { caption: d.caption })))),
      text);
  }
  const d = diagrams[0];
  return h('div', { class: ['qa-detail', `has-diagram ${d.diagram.court}`] },
    h('section', { class: 'card qa-diagram' }, renderDiagram(d.diagram, { caption: d.caption })),
    text);
}
