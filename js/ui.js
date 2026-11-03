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
