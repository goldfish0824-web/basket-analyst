// 保存した AI特筆データの表示（クォーター終了画面と振り返り画面で共通）と「大きく表示」
import { h, icon } from '../ui.js';
import { quarterLabel } from '../model.js';
import { evidenceText } from '../insights.js';

export function insightMetaText(record) {
  const d = new Date(record.createdAt);
  const time = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${time}　${quarterLabel(record.quarter)}${record.inProgress ? '途中' : '終了'}`;
}

export function insightMeta(record) {
  return h('p', { class: 'insight-meta' },
    insightMetaText(record),
    record.source === 'ai' ? h('span', { class: 'src ai' }, 'AIが候補から選択') : h('span', { class: 'src local' }, '（自動抽出・AIなし）'),
    record.source === 'local' && record.note ? h('span', { class: 'muted' }, `理由：${record.note}`) : null);
}

/** 行（大きな文字）と、その下の根拠の数字 */
export function insightLines(record, names) {
  return h('ol', { class: 'insight-lines' }, record.items.map((it) =>
    h('li', null,
      h('p', { class: 'insight-line' }, it.line),
      h('p', { class: 'insight-evidence' }, evidenceText(it.candidate, names)))));
}

/** 1回分の結果（見出し・行・「大きく表示」） */
export function insightRecordView(record, names) {
  return h('div', { class: 'insight-record' },
    insightMeta(record),
    insightLines(record, names),
    h('div', { class: 'row' },
      h('button', { class: 'btn big', type: 'button', onclick: () => showBig(record, names) }, icon('expand'), '大きく表示')));
}

/** コーチに見せる用：黒背景・特大文字の全画面。どこをタップしても閉じる */
export function showBig(record, names) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') close();
  };
  const overlay = h('div', { class: 'bigview', role: 'dialog', 'aria-modal': 'true', 'aria-label': '大きく表示', onclick: close },
    h('button', { class: 'btn bigview-close', type: 'button', onclick: close }, '閉じる'),
    h('ol', { class: 'bigview-lines' }, record.items.map((it) =>
      h('li', null,
        h('p', { class: 'bv-line' }, it.line),
        h('p', { class: 'bv-evidence' }, evidenceText(it.candidate, names))))),
    record.source === 'local' ? h('p', { class: 'bv-note' }, '（自動抽出・AIなし）') : null);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}
