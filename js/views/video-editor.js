// YouTube 動画の登録（試合全体で1本、またはクォーターごと）と、動画の何分何秒が開始かの入力
import { h } from '../ui.js';
import { parseYouTubeId, parseClock, formatClock, videoQuarterOptions } from '../review.js';

/**
 * videoEditor(videos, { maxQuarter }) → { el, read() }
 * read() は { videos } か { error } を返す。空の行は無視する。
 */
export function videoEditor(initial = [], { maxQuarter = 4 } = {}) {
  const rows = h('div', { class: 'video-rows' });
  const options = videoQuarterOptions(maxQuarter);

  const addRow = (v = { url: '', quarter: null, offsetSec: 0 }) => {
    const url = h('input', {
      class: 'v-url', type: 'url', inputmode: 'url', value: v.url || '', placeholder: 'https://youtu.be/…',
      autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'YouTube の URL',
    });
    const scope = h('select', { class: 'v-scope', 'aria-label': '動画の対象' },
      options.map((o) => h('option', { value: o.value, selected: String(v.quarter ?? '') === o.value }, o.label)));
    const offset = h('input', {
      class: 'v-offset', type: 'text', inputmode: 'numeric', value: v.url ? formatClock(v.offsetSec || 0) : '',
      placeholder: '例 3:25', 'aria-label': '動画の何分何秒が開始か',
    });
    const status = h('span', { class: 'v-status' });
    const check = () => {
      const has = url.value.trim();
      const ok = parseYouTubeId(url.value);
      status.textContent = !has ? '' : ok ? '✓ 読めます' : 'URLを確認';
      status.className = `v-status ${!has ? '' : ok ? 'ok' : 'ng'}`;
    };
    url.addEventListener('input', check);
    check();
    const row = h('div', { class: 'video-row' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'YouTube の URL'), url, status),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '対象'), scope),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '開始の位置（分:秒）'), offset),
      h('button', { class: 'btn small', type: 'button', 'aria-label': 'この動画を外す', onclick: () => row.remove() }, '外す'));
    rows.appendChild(row);
    return row;
  };

  for (const v of initial) addRow(v);
  if (!initial.length) addRow();

  const el = h('div', { class: 'video-editor' },
    rows,
    h('button', { class: 'btn', type: 'button', onclick: () => addRow().querySelector('input').focus() }, '＋ 動画を追加'),
    h('p', { class: 'field-note' },
      '「開始の位置」は、試合全体の動画なら試合開始（1Q開始）、クォーターごとの動画ならそのクォーター開始が、動画の何分何秒かを入れます。対応する形式：youtube.com/watch?v=…、youtu.be/…、youtube.com/live/…'),
    h('p', { class: 'field-note' },
      'ずれが大きいクォーターがあるときは、同じ URL を対象「3Q」などでもう1行追加し、そのクォーター開始の位置を入れると、そのクォーターだけ合わせ直せます。'));

  return {
    el,
    read() {
      const videos = [];
      for (const row of rows.querySelectorAll('.video-row')) {
        const url = row.querySelector('.v-url').value.trim();
        const offsetText = row.querySelector('.v-offset').value.trim();
        if (!url && !offsetText) continue;
        if (!parseYouTubeId(url)) return { error: `YouTube の URL を確認してください（${url || '空欄'}）` };
        const sec = offsetText === '' ? 0 : parseClock(offsetText);
        if (sec == null) return { error: `開始の位置は「分:秒」で入れてください（${offsetText}）` };
        const q = row.querySelector('.v-scope').value;
        videos.push({ url, quarter: q === '' ? null : Number(q), offsetSec: sec });
      }
      return { videos };
    },
  };
}
