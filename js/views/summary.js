// 集計画面（SPEC 4章）：ボックススコア、相手チーム、チーム指標、シュートチャート、クォーター別得点、守備隊形別
import * as db from '../db.js';
import { h, replace, toast, formatDate, icon } from '../ui.js';
import { quarterLabel, sortNumbers, SHOT_TAGS, TEAM_LABEL, describeEvent } from '../model.js';
import { ZONES, ZONE_LABELS } from '../court.js';
import {
  scoreOf, scoreByQuarter, teamBox, teamIndicators, byDefense, filterShots, zoneStats, shotTotals,
  pctText, decimalText,
} from '../stats.js';
import { createCourt, drawShots, drawZoneStats, drawZoneLines } from '../court-svg.js';
import { exportGame } from './shared.js';

const TABS = [
  { key: 'box', label: 'ボックススコア' },
  { key: 'chart', label: 'シュートチャート' },
  { key: 'team', label: 'チーム指標・守備隊形別' },
];

export async function renderSummary(root, params, app) {
  const game = await db.getGame(params.gameId);
  if (!game) {
    toast('試合が見つかりません', { kind: 'error' });
    app.go('#/');
    return;
  }
  const events = await db.listEvents(game.id);
  const score = scoreOf(events);
  let tab = sessionGet('summaryTab') || 'box';

  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  const content = h('div', { class: 'summary-content' });

  function drawTabs() {
    replace(tabBar, TABS.map((t) => h('button', {
      class: ['tab', tab === t.key && 'on'], type: 'button', role: 'tab', 'aria-selected': String(tab === t.key),
      onclick: () => {
        tab = t.key;
        sessionSet('summaryTab', tab);
        drawTabs();
        drawContent();
      },
    }, t.label)));
  }

  function drawContent() {
    if (tab === 'box') replace(content, boxSection(game, events));
    else if (tab === 'chart') replace(content, chartSection(game, events));
    else replace(content, teamSection(game, events, app.settings.defenses));
  }

  root.append(
    h('header', { class: 'page-head' },
      h('a', { class: 'btn', href: '#/' }, icon('home'), 'ホーム'),
      h('div', { class: 'head-title' },
        h('h1', null, `集計　vs ${game.opponent || '相手'}`),
        h('span', { class: 'muted' }, `${formatDate(game.date)} ${game.tournament || ''}`)),
      h('div', { class: 'head-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => exportGame(game) }, icon('share'), '書き出す'),
        h('a', { class: 'btn', href: `#/game/${game.id}/review` }, icon('film'), '振り返り'),
        h('a', { class: 'btn primary', href: `#/game/${game.id}/record` }, icon('pencil'), '記録へ'))),
    h('div', { class: 'page wide' },
      h('div', { class: 'summary-top' },
        h('div', { class: 'big-score' },
          h('span', { class: 'bs-team' }, '自チーム'),
          h('span', { class: 'bs-num us' }, score.us),
          h('span', { class: 'bs-sep' }, '−'),
          h('span', { class: 'bs-num opp' }, score.opp),
          h('span', { class: 'bs-team' }, game.opponent || '相手')),
        quarterTable(events)),
      tabBar,
      content),
  );
  drawTabs();
  drawContent();
}

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

// ---- 表の部品 ----

function table(headers, rows, { className = '', foot = [] } = {}) {
  return h('div', { class: 'table-wrap' },
    h('table', { class: ['stats', className] },
      h('thead', null, h('tr', null, headers.map((c) => h('th', { scope: 'col', class: c.cls || '' }, c.label)))),
      h('tbody', null, rows.map((r) => h('tr', { class: r.cls || '' }, r.cells.map((c, i) => (i === 0 ? h('th', { scope: 'row' }, c) : h('td', null, c)))))),
      foot.length ? h('tfoot', null, foot.map((r) => h('tr', { class: r.cls || '' }, r.cells.map((c, i) => (i === 0 ? h('th', { scope: 'row' }, c) : h('td', null, c)))))) : null));
}

export function quarterTable(events) {
  const q = scoreByQuarter(events);
  const total = scoreOf(events);
  const headers = [{ label: '' }, ...q.quarters.map((n) => ({ label: quarterLabel(n) })), { label: '計' }];
  return table(headers, [
    { cells: ['自チーム', ...q.us, total.us], cls: 'us' },
    { cells: ['相手', ...q.opp, total.opp], cls: 'opp' },
  ], { className: 'quarter-table' });
}

const ma = (m, a) => `${m}-${a}`;

// ---- ボックススコア ----

export function boxSection(game, events) {
  const us = teamBox(events, 'us', game.roster);
  const usHead = [
    { label: '背番号' }, { label: '呼び名', cls: 'name' }, { label: '得点' }, { label: 'FG' }, { label: 'FG%' },
    { label: '3P' }, { label: '3P%' }, { label: 'FT' }, { label: 'FT%' }, { label: 'OR' }, { label: 'DR' },
    { label: 'アシスト' }, { label: 'スティール' }, { label: 'ブロック' }, { label: 'ターンオーバー' }, { label: 'ファウル' },
  ];
  const usLine = (label, name, r) => [
    label, name, r.pts, ma(r.fgm, r.fga), pctText(r.fgm, r.fga), ma(r.tpm, r.tpa), pctText(r.tpm, r.tpa),
    ma(r.ftm, r.fta), pctText(r.ftm, r.fta), r.oreb, r.dreb, r.ast, r.stl, r.blk, r.to, r.pf,
  ];
  const usRows = us.rows.map((r) => ({ cells: usLine(`#${r.number}`, r.name, r), cls: r.pf >= 5 ? 'out' : r.pf === 4 ? 'pf4' : r.pf === 3 ? 'pf3' : '' }));
  const usFoot = [];
  if (us.other) usFoot.push({ cells: usLine('チーム', '補正・チームリバウンド等', us.other), cls: 'sub' });
  usFoot.push({ cells: usLine('合計', '', us.total), cls: 'total' });

  const oppPlayers = sortNumbers([...new Set([...(game.oppNumbers || []), ...events.filter((e) => e.team === 'opp' && e.player != null).map((e) => e.player)])])
    .map((n) => ({ number: n }));
  const opp = teamBox(events, 'opp', oppPlayers);
  const oppHead = [{ label: '背番号' }, { label: '得点' }, { label: 'FG' }, { label: 'FG%' }, { label: '3P' }, { label: '3P%' }, { label: 'ファウル' }];
  const oppLine = (label, r) => [label, r.pts, ma(r.fgm, r.fga), pctText(r.fgm, r.fga), ma(r.tpm, r.tpa), pctText(r.tpm, r.tpa), r.pf];
  const oppRows = opp.rows
    .filter((r) => r.pts || r.fga || r.pf || r.fta || r.oreb || r.dreb || r.to)
    .map((r) => ({ cells: oppLine(`#${r.number}`, r), cls: r.pf >= 5 ? 'out' : r.pf === 4 ? 'pf4' : r.pf === 3 ? 'pf3' : '' }));
  const oppFoot = [];
  if (opp.other) oppFoot.push({ cells: oppLine('番号なし', opp.other), cls: 'sub' });
  oppFoot.push({ cells: oppLine('合計', opp.total), cls: 'total' });
  const t = opp.total;

  return h('div', { class: 'box-section' },
    h('section', { class: 'card' },
      h('h2', null, 'ボックススコア（自チーム）'),
      table(usHead, usRows, { className: 'box us', foot: usFoot }),
      h('p', { class: 'legend' }, h('span', { class: 'swatch pf3' }), 'ファウル3　', h('span', { class: 'swatch pf4' }), 'ファウル4　', h('span', { class: 'swatch out' }), 'ファウル5')),
    h('section', { class: 'card' },
      h('h2', null, '相手チーム'),
      table(oppHead, oppRows.length ? oppRows : [{ cells: ['記録なし', '', '', '', '', '', ''] }], { className: 'box opp', foot: oppFoot }),
      h('p', { class: 'team-line' },
        `チーム：FT ${ma(t.ftm, t.fta)}（${pctText(t.ftm, t.fta)}）　OR ${t.oreb}　DR ${t.dreb}　ターンオーバー ${t.to}`)));
}

// ---- チーム指標・守備隊形別 ----

export function teamSection(game, events, defenses) {
  const ind = teamIndicators(events);
  const rows = [
    ['ポゼッション推定', decimalText(ind.us.poss), decimalText(ind.opp.poss)],
    ['1ポゼッションあたり得点', decimalText(ind.us.ppp, 2), decimalText(ind.opp.ppp, 2)],
    ['OR率', ind.us.orPct == null ? '—' : `${Math.round(ind.us.orPct * 100)}%`, ind.opp.orPct == null ? '—' : `${Math.round(ind.opp.orPct * 100)}%`],
    ['セカンドチャンス得点', ind.us.secondChancePts, ind.opp.secondChancePts],
    ['速攻得点', ind.us.fastBreakPts, ind.opp.fastBreakPts],
  ].map((cells) => ({ cells }));

  const defHead = [{ label: '守備隊形' }, { label: 'FG' }, { label: 'FG%' }, { label: '3P' }, { label: '3P%' }, { label: 'ターンオーバー' }, { label: '得点' }];
  const defRows = (team) => {
    const list = byDefense(events, team, defenses);
    if (!list.length) return [{ cells: ['記録なし', '', '', '', '', '', ''] }];
    return list.map((r) => ({ cells: [r.defense, ma(r.fgm, r.fga), pctText(r.fgm, r.fga), ma(r.tpm, r.tpa), pctText(r.tpm, r.tpa), r.to, r.pts] }));
  };

  return h('div', { class: 'team-section' },
    h('section', { class: 'card' },
      h('h2', null, 'チーム指標'),
      table([{ label: '' }, { label: '自チーム' }, { label: '相手' }], rows, { className: 'indicators' }),
      h('ul', { class: 'notes' },
        h('li', null, 'ポゼッション推定 ＝ FG試投 ＋ 0.44 × FT試投 − OR ＋ ターンオーバー'),
        h('li', null, 'OR率 ＝ 自OR ÷（自OR ＋ 相手DR）。相手の列は 相手OR ÷（相手OR ＋ 自DR）'),
        h('li', null, 'セカンドチャンス得点・速攻得点は、その種類タグが付いたシュート成功の得点'))),
    h('section', { class: 'card' },
      h('h2', null, '自チームの攻撃（相手の守備隊形別）'),
      table(defHead, defRows('us'), { className: 'defense' })),
    h('section', { class: 'card' },
      h('h2', null, '相手の攻撃（自チームの守備隊形別）'),
      table(defHead, defRows('opp'), { className: 'defense' }),
      h('p', { class: 'field-note' }, '得点はFGとFTの合計（得点補正は含めない）。')));
}

// ---- シュートチャート ----

export function chartSection(game, events) {
  const state = { team: 'us', player: 'all', quarter: 'all', defense: 'all', tag: 'all', overlay: true };
  const { svg, layers } = createCourt({ label: 'シュートチャート' });
  drawZoneLines(layers.zones);
  const filters = h('div', { class: 'chart-filters' });
  const totals = h('div', { class: 'chart-totals' });
  const zoneTable = h('div', { class: 'zone-table' });
  const picked = h('p', { class: 'picked muted' }, '印をタップすると内容を表示します');

  const select = (label, key, options) => h('label', { class: 'field inline' },
    h('span', { class: 'field-label' }, label),
    h('select', {
      onchange: (ev) => {
        state[key] = ev.target.value;
        draw();
      },
    }, options.map(([v, l]) => h('option', { value: v, selected: state[key] === v }, l))));

  function playerOptions() {
    const nums = new Set();
    for (const e of events) if (e.type === 'fg' && e.team === state.team && e.player != null) nums.add(e.player);
    const names = new Map(game.roster.map((p) => [String(p.number), p.name]));
    const opts = [['all', 'すべて']];
    for (const n of sortNumbers([...nums])) opts.push([n, state.team === 'us' && names.get(n) ? `#${n} ${names.get(n)}` : `#${n}`]);
    if (state.team === 'opp' && events.some((e) => e.type === 'fg' && e.team === 'opp' && e.player == null)) opts.push(['none', '番号なし']);
    return opts;
  }

  function quarterOptions() {
    const qs = [...new Set(events.filter((e) => e.type === 'fg').map((e) => e.quarter))].sort((a, b) => a - b);
    const opts = [['all', 'すべて'], ['H1', '前半（1Q・2Q）'], ['H2', '後半（3Q・4Q）']];
    for (const q of qs) opts.push([String(q), quarterLabel(q)]);
    if (qs.some((q) => q > 4)) opts.push(['OT', '延長すべて']);
    return opts;
  }

  function defenseOptions() {
    const ds = [...new Set(events.filter((e) => e.type === 'fg' && e.team === state.team).map((e) => e.defense || '未設定'))];
    return [['all', 'すべて'], ...ds.map((d) => [d, d])];
  }

  function drawFilters() {
    replace(filters,
      h('div', { class: 'seg', role: 'group', 'aria-label': 'チーム' }, ['us', 'opp'].map((t) =>
        h('button', {
          class: ['seg-btn', t, state.team === t && 'on'], type: 'button', 'aria-pressed': String(state.team === t),
          onclick: () => {
            state.team = t;
            state.player = 'all';
            state.defense = 'all';
            draw();
          },
        }, TEAM_LABEL[t]))),
      select('選手', 'player', playerOptions()),
      select('クォーター', 'quarter', quarterOptions()),
      select(state.team === 'us' ? '相手の守備隊形' : '自チームの守備隊形', 'defense', defenseOptions()),
      select('種類タグ', 'tag', [['all', 'すべて'], ...SHOT_TAGS.map((t) => [t, t]), ['none', 'タグなし']]),
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', checked: state.overlay,
          onchange: (ev) => {
            state.overlay = ev.target.checked;
            draw();
          },
        }),
        'ゾーン別の成功-試投を重ねる'));
  }

  function draw() {
    drawFilters();
    const shots = filterShots(events, state);
    const zs = zoneStats(shots);
    drawShots(layers.shots, shots, {
      onSelect: (e) => {
        const name = e.team === 'us' ? (game.roster.find((p) => String(p.number) === e.player) || {}).name : '';
        picked.textContent = `${quarterLabel(e.quarter)}　${describeEvent(e, ZONE_LABELS)}${name ? `（${name}）` : ''}${e.defense ? `　守備：${e.defense}` : ''}`;
      },
    });
    if (state.overlay) drawZoneStats(layers.overlay, zs);
    else replace(layers.overlay);
    const t = shotTotals(shots);
    const twoM = t.fgm - t.tpm;
    const twoA = t.fga - t.tpa;
    replace(totals,
      h('div', { class: 'tot' }, h('span', { class: 'tot-label' }, 'FG'), h('span', { class: 'tot-val' }, `${t.fgm}-${t.fga}`), h('span', { class: 'tot-pct' }, pctText(t.fgm, t.fga))),
      h('div', { class: 'tot' }, h('span', { class: 'tot-label' }, '2P'), h('span', { class: 'tot-val' }, `${twoM}-${twoA}`), h('span', { class: 'tot-pct' }, pctText(twoM, twoA))),
      h('div', { class: 'tot' }, h('span', { class: 'tot-label' }, '3P'), h('span', { class: 'tot-val' }, `${t.tpm}-${t.tpa}`), h('span', { class: 'tot-pct' }, pctText(t.tpm, t.tpa))));
    replace(zoneTable, table(
      [{ label: 'ゾーン' }, { label: '成功-試投' }, { label: '%' }],
      ZONES.map((z) => ({ cells: [ZONE_LABELS[z], `${zs[z].made}-${zs[z].att}`, pctText(zs[z].made, zs[z].att)], cls: zs[z].att ? '' : 'empty' })),
      { className: 'zones' }));
  }
  draw();

  return h('div', { class: 'chart-section' },
    h('div', { class: ['chart-court', 'card'] },
      svg,
      h('div', { class: 'chart-legend' },
        h('span', { class: 'lg' }, h('span', { class: 'lg-made' }), '成功'),
        h('span', { class: 'lg' }, h('span', { class: 'lg-miss' }, '×'), '失敗'),
        h('span', { class: 'lg' }, h('span', { class: 'lg-swatch us' }), '自チーム'),
        h('span', { class: 'lg' }, h('span', { class: 'lg-swatch opp' }), '相手')),
      picked),
    h('div', { class: 'chart-side' },
      h('section', { class: 'card' }, h('h2', null, '絞り込み'), filters),
      h('section', { class: 'card' }, totals, zoneTable)));
}
