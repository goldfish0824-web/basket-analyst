// 場面別Q&A の印刷用ページ（A4 縦・両面・バインダー用）。#/qa/print（すべて）／#/qa/print/<id>（1つだけ）
// 画面では「印刷する」で、ブラウザの印刷（PDF に保存も）ができる。tools/make-qa-pdf.cjs はこのページから PDF を作る。
import { h, icon, applyTheme } from '../ui.js';
import { unitDiagrams, itemDiagrams, CATEGORY_LABEL, patternLabel } from '../qa.js';
import { renderDiagram } from './diagram.js';
import { printPlan, splitMove } from '../qa-print.js';

const NOTE = '一般的な考え方の例です（下書き）。チームとしての方針はコーチと相談して決めてください。';

function moves(list) {
  return h('ol', { class: 'qp-moves' }, list.map((t) => {
    const m = splitMove(t);
    return h('li', { class: m.n ? '' : 'plain' }, m.n ? h('span', { class: 'qp-n' }, String(m.n)) : null, m.text);
  }));
}

function points(list) {
  return h('ol', { class: 'qp-points' }, list.map((t) => h('li', null, t)));
}

/** 図の並び：オール1枚は幅いっぱい、ハーフ1枚は左に図・右に文、手順は横に並べる */
function figures(diagrams) {
  const kind = diagrams.length > 1 ? 'steps' : diagrams[0] && diagrams[0].diagram.court === 'full' ? 'full' : 'half';
  return { kind, el: h('div', { class: ['qp-figs', kind] }, diagrams.map((d) => h('div', { class: 'qp-fig' }, renderDiagram(d.diagram, { caption: d.caption })))) };
}

function block(diagrams, body) {
  if (!diagrams.length) return h('div', { class: 'qp-block' }, body);
  const f = figures(diagrams);
  return h('div', { class: ['qp-block', `with-${f.kind}`] }, f.el, h('div', { class: 'qp-body' }, body));
}

function patternBlocks(item) {
  return item.patterns.map((p, i) => h('section', { class: 'qp-pattern' },
    h('h3', null, h('span', { class: 'qp-plabel' }, patternLabel(i)), p.name),
    block(unitDiagrams(p), moves(p.points || []))));
}

function itemArticle(entry) {
  const { item, no } = entry;
  const parts = [];
  parts.push(h('header', { class: 'qp-head' },
    h('span', { class: 'qp-no' }, `No.${no}`),
    h('span', { class: 'qp-cat' }, CATEGORY_LABEL[item.cat]),
    h('h2', null, item.title)));
  parts.push(h('p', { class: 'qp-situation' }, h('strong', null, '状況　'), item.situation));
  if (Array.isArray(item.patterns)) {
    parts.push(h('section', { class: 'qp-common' }, h('h3', null, 'どのパターンでも'), points(item.points)));
    for (const v of entry.versions) {
      if (v.label) {
        parts.push(h('section', { class: 'qp-mirror-head' },
          h('h3', null, `${v.label}（No.${no} のつづき）`),
          h('p', null, 'スローインする側が図と反対になる試合のための形です。図と説明文の左右（右手・左手のドリブルなど）を入れ替えています。')));
      }
      parts.push(...patternBlocks(v.item));
    }
  } else {
    const ds = itemDiagrams(item);
    parts.push(block(ds, h('div', null, h('h3', null, '対処の例'), points(item.points))));
  }
  if (item.watch && item.watch.length) {
    parts.push(h('section', { class: 'qp-watch' }, h('h3', null, 'アプリで見る数字'), h('ul', null, item.watch.map((w) => h('li', null, w)))));
  }
  return h('article', { class: 'qp-item', 'data-no': String(no) }, ...parts);
}

function cover(sections, pages) {
  const date = new Date();
  return h('section', { class: 'qp-cover' },
    h('p', { class: 'qp-brand' }, 'BasketBall Analyst'),
    h('h1', null, '場面別Q&A'),
    h('p', { class: 'qp-sub' }, `よくある場面と対処の例　印刷用（A4・両面）　${date.getFullYear()}年${date.getMonth() + 1}月版`),
    h('p', { class: 'qp-note' }, NOTE),
    h('div', { class: 'qp-legend' },
      h('span', null, h('b', { class: 'qp-off' }, '●'), '攻め'),
      h('span', null, h('b', { class: 'qp-def' }, '▲'), '守り'),
      h('span', null, '→ 移動　- - → パス　〰→ ドリブル　─┤ スクリーン'),
      h('span', null, h('b', { class: 'qp-order' }, '1'), '動きの順番')),
    h('h2', null, '目次'),
    h('div', { class: 'qp-toc' }, sections.map((s) => h('section', { class: 'qp-toc-sec' },
      h('h3', null, s.label),
      h('ol', null, s.items.map((e) => h('li', null,
        h('span', { class: 'qp-toc-no' }, `No.${e.no}`),
        h('span', { class: 'qp-toc-title' }, e.item.title),
        pages && pages[e.no] ? h('span', { class: 'qp-toc-page' }, `${pages[e.no]}ページ`) : null)))))));
}

export async function renderQaPrint(root, params, app) {
  // 紙に合う明るい配色で描く（画面を離れるときに戻す）
  applyTheme('light');
  document.body.classList.add('printing');
  const sections = printPlan();
  const all = sections.flatMap((s) => s.items);
  const only = params.id ? all.filter((e) => e.id === params.id) : null;
  const pages = typeof window !== 'undefined' ? window.__qaPrintPages || null : null;

  root.append(
    h('header', { class: 'page-head no-print' },
      h('a', { class: 'btn', href: '#/qa' }, icon('back'), '場面別Q&A'),
      h('div', { class: 'head-title' }, h('h1', null, '印刷用（A4・両面）'), h('span', { class: 'muted' }, `${all.length}場面`)),
      h('div', { class: 'head-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => window.print() }, icon('share'), '印刷する'))),
    h('div', { class: 'qa-print' },
      h('p', { class: 'qp-hint no-print' }, '「印刷する」でブラウザの印刷を開きます。用紙は A4・縦、両面印刷（長辺とじ）を選んでください。「PDF に保存」も選べます。'),
      only ? null : cover(sections, pages),
      (only || all).map(itemArticle)),
  );
  return () => {
    document.body.classList.remove('printing');
    applyTheme(app.settings.theme);
  };
}
