// 画面づくりの小さな道具。利用者が入力した文字は textContent で入れる（innerHTML は使わない）。

/**
 * h('button', { class: 'btn', onclick: fn }, '文字', child)
 * props の on* はイベント、class / style / dataset / attrs は特別扱い。
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

// ---- 通知（画面下に数秒） ----

let toastTimer = null;
export function toast(message, { kind = 'info', ms = 2200 } = {}) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = `toast ${kind}`;
  }, ms);
}

// ---- モーダル ----

/**
 * modal({ title, body, actions:[{label, kind, onClick}], wide })
 * onClick が false を返したら閉じない。戻り値は閉じる関数。
 */
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => {
    backdrop.remove();
    if (onClose) onClose();
  };
  const box = h(
    'div',
    { class: ['modal', wide && 'wide'], role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' },
    title ? h('h2', { class: 'modal-title' }, title) : null,
    h('div', { class: 'modal-body' }, body),
    actions.length
      ? h(
          'div',
          { class: 'modal-actions' },
          actions.map((a) =>
            h(
              'button',
              {
                class: ['btn', a.kind || ''],
                type: 'button',
                onclick: async () => {
                  const r = a.onClick ? await a.onClick() : undefined;
                  if (r !== false) close();
                },
              },
              a.label,
            ),
          ),
        )
      : null,
  );
  backdrop.appendChild(box);
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) close();
  });
  document.body.appendChild(backdrop);
  return close;
}

export function confirmDialog(message, { ok = 'OK', cancel = 'やめる', danger = false, title = '' } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    modal({
      title,
      body: h('p', { class: 'confirm-text' }, message),
      actions: [
        { label: cancel, onClick: () => { answered = true; resolve(false); } },
        { label: ok, kind: danger ? 'danger' : 'primary', onClick: () => { answered = true; resolve(true); } },
      ],
      onClose: () => {
        if (!answered) resolve(false);
      },
    });
  });
}

// ---- ファイル ----

/** JSON をファイルとして渡す（iPad は共有シート、それ以外はダウンロード） */
export async function saveJsonFile(obj, fileName) {
  const text = JSON.stringify(obj, null, 1);
  const blob = new Blob([text], { type: 'application/json' });
  const isTouch = navigator.maxTouchPoints > 1;
  try {
    const file = new File([blob], fileName, { type: 'application/json' });
    if (isTouch && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: fileName });
      return true;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return false; // 利用者が共有を閉じた
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: fileName });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

export function pickFile(accept = 'application/json,.json') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      input.remove();
      resolve(f || null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y) return iso;
  const wd = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
  return `${y}/${m}/${d}（${wd}）`;
}

export function todayString() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function isStandalone() {
  return (
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true
  );
}

// ---- アイコン（線で描いた簡単な SVG。色は文字色に合わせる） ----

const ICONS = {
  home: ['M3 11.5 12 4l9 7.5', 'M5.5 10v10h4.5v-6h4v6h4.5V10'],
  settings: ['M4 6h9', 'M17 6h3', 'M4 12h3', 'M11 12h9', 'M4 18h11', 'M19 18h1', { c: [15, 6, 2] }, { c: [9, 12, 2] }, { c: [17, 18, 2] }],
  plus: ['M12 5v14', 'M5 12h14'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  undo: ['M9 13 4 8l5-5', 'M4 8h10.5a5.5 5.5 0 0 1 0 11H11'],
  flag: ['M6 21V4', 'M6 4h11l-2.5 4L17 12H6'],
  share: ['M12 15V3', 'M7.5 7.5 12 3l4.5 4.5', 'M5 13v7h14v-7'],
  download: ['M12 3v12', 'M7.5 10.5 12 15l4.5-4.5', 'M5 13v7h14v-7'],
  film: [{ r: [3.5, 5, 17, 14, 2.5] }, 'M10 9.2v5.6l4.8-2.8z'],
  chart: ['M5 20v-8', 'M12 20V5', 'M19 20v-5', 'M3 20h18'],
  pencil: ['M14.5 5.5l4 4', 'M4 20l1-4.5L15.8 4.7a1.9 1.9 0 0 1 2.7 0l.8.8a1.9 1.9 0 0 1 0 2.7L8.5 19z'],
  back: ['M15 5l-7 7 7 7'],
  sparkle: ['M12 3.5l1.9 5.1L19 10.5l-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z', 'M19 3v3', 'M17.5 4.5h3'],
  expand: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  play: [{ fill: 'M8 5.5v13l10.5-6.5z' }],
  more: [{ dot: [6, 12] }, { dot: [12, 12] }, { dot: [18, 12] }],
  check: ['M5 12.5l4.5 4.5L19 7'],
  whistle: ['M3 9h9.5a5.5 5.5 0 1 1-5 7.8L3 13.5z', 'M12.5 9V5', { c: [12.5, 14.5, 1.6] }],
  book: ['M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z', 'M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5', 'M8 7.5h8', 'M8 11h6'],
};

/** icon('home') → <svg class="icon"> */
export function icon(name, extraClass = '') {
  const parts = ICONS[name] || [];
  return s('svg', { class: `icon ${extraClass}`.trim(), viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    parts.map((p) => {
      if (typeof p === 'string') return s('path', { d: p });
      if (p.c) return s('circle', { cx: p.c[0], cy: p.c[1], r: p.c[2] });
      if (p.r) return s('rect', { x: p.r[0], y: p.r[1], width: p.r[2], height: p.r[3], rx: p.r[4] });
      if (p.fill) return s('path', { d: p.fill, class: 'fill' });
      if (p.dot) return s('circle', { cx: p.dot[0], cy: p.dot[1], r: 1.6, class: 'fill' });
      return null;
    }));
}

/** アプリのマーク（ホームの見出し用） */
export function brandMark() {
  return s('svg', { class: 'brand-mark', viewBox: '0 0 48 48', 'aria-hidden': 'true' },
    s('defs', null,
      s('linearGradient', { id: 'bm-g', x1: '0', y1: '0', x2: '1', y2: '1' },
        s('stop', { offset: '0', 'stop-color': '#1b3a7a' }),
        s('stop', { offset: '1', 'stop-color': '#0b1430' }))),
    s('rect', { width: 48, height: 48, rx: 12, fill: 'url(#bm-g)' }),
    s('path', { d: 'M9 9v8a15 15 0 0 0 30 0V9', fill: 'none', stroke: '#7fb0ff', 'stroke-width': 2.4, 'stroke-linecap': 'round' }),
    s('circle', { cx: 24, cy: 31, r: 8, fill: '#eb6834' }),
    s('path', { d: 'M16 31h16M24 23v16', stroke: '#7a2f10', 'stroke-width': 1.4 }));
}

/** 画面の配色（ダーク／ライト）を反映する */
export function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#eef1f6' : '#080d18');
}
