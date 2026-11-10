// 集計画面の「試合の流れ・比較」と「スコアシート」
import { h, s, replace } from '../ui.js';
import { quarterLabel, quarterState, REGULAR_QUARTERS } from '../model.js';
import { formatClock } from '../clock.js';
import { scoreFlow, scoreAt, quarterAt, teamCompare, pct, buildScoreSheet } from '../flow.js';

const flowOpts = (settings) => ({ quarterMin: settings.quarterMin, otMin: settings.otMin });

// ---- 試合の流れ（得点の推移のグラフ） ----

function flowChart(game, events, settings) {
  const flow = scoreFlow(events, flowOpts(settings));
  const qs = quarterState(events);
  const lastT = Math.max(0, ...flow.points.map((p) => p.t), ...flow.timeouts.map((p) => p.t));
  // 終わったクォーターまでは線を延ばす（試合中は最後の記録まで）
  const doneQ = qs.phase === 'break' ? qs.quarter : qs.quarter - 1;
  const doneEnd = doneQ > 0 && flow.quarters[doneQ - 1] ? flow.quarters[doneQ - 1].end : 0;
  const endT = Math.max(lastT, doneEnd);
  const W = 1000;
  const H = 300;
  const pad = { l: 44, r: 16, t: 14, b: 34 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;
  const step = flow.maxScore > 100 ? 20 : 10;
  const yMax = Math.max(step, Math.ceil(flow.maxScore / step) * step);
  const x = (t) => pad.l + (flow.total ? (t / flow.total) * pw : 0);
  const y = (v) => pad.t + ph - (v / yMax) * ph;

  const svg = s('svg', { class: 'flow-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `得点の推移　自チーム ${scoreAt(flow, Infinity).us} − ${scoreAt(flow, Infinity).opp} 相手` });
  // 目盛り（横線）
  for (let v = 0; v <= yMax; v += step) {
    svg.append(
      s('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: v === 0 ? 'fc-base' : 'fc-grid' }),
      s('text', { x: pad.l - 8, y: y(v), class: 'fc-tick y' }, String(v)),
    );
  }
  // クォーターの区切り
  for (const q of flow.quarters) {
    if (q.start > 0) svg.append(s('line', { x1: x(q.start), x2: x(q.start), y1: pad.t, y2: pad.t + ph, class: q.q === 3 ? 'fc-half' : 'fc-grid' }));
    svg.append(s('text', { x: (x(q.start) + x(q.end)) / 2, y: H - 10, class: 'fc-tick q' }, quarterLabel(q.q)));
  }
  // 両チームの線（得点したところで上がる階段）
  for (const team of ['opp', 'us']) {
    let d = `M${x(0)} ${y(0)}`;
    let v = 0;
    for (const p of flow.points) {
      if (p.team !== team) continue;
      d += ` H${x(p.t)} V${y(p[team])}`;
      v = p[team];
    }
    d += ` H${x(endT)}`;
    svg.append(s('path', { d, class: `fc-line ${team}` }));
    if (endT > 0) svg.append(s('circle', { cx: x(endT), cy: y(v), r: 4, class: `fc-end ${team}` }));
  }
  // タイムアウト（そのチームの線の上に●）
  for (const to of flow.timeouts) {
    const v = to[to.team];
    svg.append(s('circle', { cx: x(to.t), cy: y(v), r: 6, class: `fc-to ${to.team}` },
      s('title', null, `${quarterLabel(to.quarter)}${to.clock != null ? ` 残り${formatClock(to.clock)}` : ''} タイムアウト（${to.team === 'us' ? '自チーム' : '相手'}）`)));
  }
  // なぞると、その時点の得点（十字の線と吹き出し）
  const cross = s('line', { x1: 0, x2: 0, y1: pad.t, y2: pad.t + ph, class: 'fc-cross' });
  const hit = s('rect', { x: pad.l, y: pad.t, width: pw, height: ph, class: 'fc-hit' });
  svg.append(cross, hit);
  const tip = h('div', { class: 'fc-tip', role: 'status' });
  const wrap = h('div', { class: 'fc-wrap' }, svg, tip);
  const show = (ev) => {
    const r = svg.getBoundingClientRect();
    const vx = ((ev.clientX - r.left) / r.width) * W;
    const t = Math.min(endT, Math.max(0, ((vx - pad.l) / pw) * flow.total));
    const sc = scoreAt(flow, t);
    const qa = quarterAt(flow, t);
    cross.setAttribute('x1', x(t));
    cross.setAttribute('x2', x(t));
    wrap.classList.add('hover');
    const lead = sc.us - sc.opp;
    replace(tip,
      h('div', { class: 'fc-tip-q' }, `${quarterLabel(qa.quarter)}　残り ${formatClock(qa.left)}`),
      h('div', null, h('span', { class: 'key us' }), `自チーム ${sc.us}`),
      h('div', null, h('span', { class: 'key opp' }), `相手 ${sc.opp}`),
      h('div', { class: 'fc-tip-lead' }, lead === 0 ? '同点' : `${lead > 0 ? '自チーム' : '相手'} ${Math.abs(lead)}点リード`));
    const px = ((x(t)) / W) * r.width;
    tip.style.left = `${Math.min(r.width - 150, Math.max(0, px + 12))}px`;
  };
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerleave', () => wrap.classList.remove('hover'));

  // 最大リード
  const best = { us: { v: 0, q: null }, opp: { v: 0, q: null } };
  for (const p of flow.points) {
    const d = p.us - p.opp;
    if (d > best.us.v) best.us = { v: d, q: p.quarter };
    if (-d > best.opp.v) best.opp = { v: -d, q: p.quarter };
  }
  const leadText = (team) => (best[team].v ? `${best[team].v}点（${quarterLabel(best[team].q)}）` : 'なし');
  const final = scoreAt(flow, Infinity);
  const hasClock = events.some((e) => e.clock != null);
  return h('section', { class: 'card flow-card' },
    h('div', { class: 'card-head' }, h('h2', null, '試合の流れ（得点の推移）')),
    h('div', { class: 'fc-legend' },
      h('span', null, h('span', { class: 'key us' }), `自チーム ${final.us}`),
      h('span', null, h('span', { class: 'key opp' }), `${game.opponent || '相手'} ${final.opp}`),
      h('span', null, h('span', { class: 'dot' }), 'タイムアウト')),
    wrap,
    h('p', { class: 'muted small' },
      `最大リード：自チーム ${leadText('us')}　相手 ${leadText('opp')}。`,
      hasClock ? 'グラフをなぞると、その時点の得点が出ます。' : '試合時計を使っていない記録は、クォーターの中に記録の順で並べています。'));
}

// ---- 両チームの比較 ----

function compareRows(c, showAst) {
  const shot = (m, a) => ({ text: `${m}-${a}`, sub: a ? `${pct(m, a)}%` : '—', ratio: a ? m / a : 0, pct: true });
  const num = (v) => ({ text: String(v), ratio: null, value: v });
  const none = () => ({ text: '—', ratio: 0, none: true });
  const rows = [
    ['得点', num(c.us.pts), num(c.opp.pts)],
    ['2P', shot(c.us.twoM, c.us.twoA), shot(c.opp.twoM, c.opp.twoA)],
    ['3P', shot(c.us.threeM, c.us.threeA), shot(c.opp.threeM, c.opp.threeA)],
    ['FG（2P＋3P）', shot(c.us.fgM, c.us.fgA), shot(c.opp.fgM, c.opp.fgA)],
    ['フリースロー', shot(c.us.ftM, c.us.ftA), shot(c.opp.ftM, c.opp.ftA)],
    ['オフェンスリバウンド', num(c.us.oreb), num(c.opp.oreb)],
    ['ディフェンスリバウンド', num(c.us.dreb), num(c.opp.dreb)],
    ['うちチームリバウンド', num(c.us.teamReb), num(c.opp.teamReb)],
    ...(showAst ? [['アシスト', num(c.us.ast), none()]] : []),
    ['スティール', num(c.us.stl), none()],
    ['ブロック', num(c.us.blk), none()],
    ['ターンオーバー', num(c.us.to), num(c.opp.to)],
    ['ファウル', num(c.us.pf), num(c.opp.pf)],
    ['タイムアウト', num(c.us.timeouts), num(c.opp.timeouts)],
  ];
  // 数の行は、多いほうを長さいっぱいにする。片方を記録していない行（—）は棒を出さない
  for (const [, a, b] of rows) {
    if (a.none || b.none) {
      a.ratio = 0;
      b.ratio = 0;
      a.noBar = true;
      b.noBar = true;
      continue;
    }
    if (a.ratio === null || b.ratio === null) {
      const max = Math.max(a.value || 0, b.value || 0);
      if (a.ratio === null) a.ratio = max ? a.value / max : 0;
      if (b.ratio === null) b.ratio = max ? b.value / max : 0;
    }
  }
  return rows;
}

function compareCard(game, events) {
  const n = Math.max(REGULAR_QUARTERS, ...events.map((e) => e.quarter || 0));
  const ranges = [['all', '全体'], ...Array.from({ length: Math.min(n, REGULAR_QUARTERS) }, (_, i) => [String(i + 1), `${i + 1}Q`]), ...(n > REGULAR_QUARTERS ? [['OT', '延長']] : [])];
  let range = 'all';
  const showAst = events.some((e) => e.type === 'ast');
  const filter = h('div', { class: 'cmp-filter', role: 'group', 'aria-label': 'クォーター' });
  const body = h('div', { class: 'cmp-rows' });
  const bar = (team, cell) => h('div', { class: ['cmp-cell', team] },
    h('span', { class: 'cmp-val' }, cell.text, cell.sub ? h('small', null, cell.sub) : null),
    h('span', { class: 'cmp-track' }, cell.none || cell.noBar ? null : h('span', { class: ['cmp-bar', team], style: { width: `${Math.round(cell.ratio * 100)}%` } })));
  function draw() {
    replace(filter, ranges.map(([k, label]) => h('button', {
      class: ['btn small cmp-range', range === k && 'on'], type: 'button', 'aria-pressed': String(range === k),
      onclick: () => { range = k; draw(); },
    }, label)));
    const c = teamCompare(events, range === 'all' ? 'all' : range === 'OT' ? 'OT' : Number(range));
    replace(body, compareRows(c, showAst).map(([label, a, b]) => h('div', { class: 'cmp-row' }, bar('us', a), h('div', { class: 'cmp-label' }, label), bar('opp', b))));
  }
  draw();
  return h('section', { class: 'card cmp-card' },
    h('div', { class: 'card-head' }, h('h2', null, '両チームの比較'), filter),
    h('div', { class: 'cmp-head' },
      h('span', null, h('span', { class: 'key us' }), '自チーム'),
      h('span'),
      h('span', null, h('span', { class: 'key opp' }), game.opponent || '相手')),
    body,
    h('p', { class: 'muted small' }, 'シュートの棒は成功率、ほかの棒は多いほうを長さいっぱいにしています。相手のスティール・ブロック・アシストは記録していないので「—」（棒なし）です。'));
}

export function flowSection(game, events, settings) {
  return h('div', { class: 'flow-section' }, flowChart(game, events, settings), compareCard(game, events));
}

// ---- スコアシート ----

const quarterInk = (q) => (q % 2 === 1 ? 'q-odd' : 'q-even'); // 1Q・3Q は赤、2Q・4Q は黒（FIBA のスコアシートと同じ）

function timeoutBoxes(list, count) {
  const cells = [];
  for (let i = 0; i < Math.max(count, list.length); i++) {
    const m = list[i];
    cells.push(h('span', { class: ['sh-box', i < list.length && 'used'] }, i < list.length ? (m == null ? '○' : String(m)) : ''));
  }
  return cells;
}

function teamBlock(label, name, team, quarters) {
  const foulRow = (q) => h('div', { class: 'sh-tf-row' },
    h('span', { class: 'sh-tf-q' }, `${q}Q`),
    [1, 2, 3, 4].map((k) => h('span', { class: ['sh-box tf', k <= team.teamFouls[q - 1] && 'crossed', k <= team.teamFouls[q - 1] && quarterInk(q)] }, String(k))),
    team.teamFouls[q - 1] > 4 ? h('span', { class: 'sh-more' }, `計${team.teamFouls[q - 1]}`) : null);
  return h('section', { class: 'sh-team' },
    h('div', { class: 'sh-team-head' }, h('span', { class: 'sh-team-label' }, label), h('span', { class: 'sh-team-name' }, name)),
    h('div', { class: 'sh-meta' },
      h('div', { class: 'sh-to' },
        h('div', { class: 'sh-meta-title' }, 'タイムアウト（何分目）'),
        h('div', { class: 'sh-to-row' }, h('span', { class: 'sh-to-label' }, '前半'), timeoutBoxes(team.timeouts.h1, 2)),
        h('div', { class: 'sh-to-row' }, h('span', { class: 'sh-to-label' }, '後半'), timeoutBoxes(team.timeouts.h2, 3)),
        quarters > REGULAR_QUARTERS || team.timeouts.ot.length ? h('div', { class: 'sh-to-row' }, h('span', { class: 'sh-to-label' }, '延長'), timeoutBoxes(team.timeouts.ot, 1)) : null),
      h('div', { class: 'sh-tf' },
        h('div', { class: 'sh-meta-title' }, 'チームファウル'),
        h('div', { class: 'sh-tf-grid' }, [1, 2, 3, 4].map(foulRow)))),
    h('table', { class: 'sh-players' },
      h('thead', null, h('tr', null,
        h('th', null, '背番号'), h('th', { class: 'name' }, '選手名'), h('th', null, '出場'),
        [1, 2, 3, 4, 5].map((k) => h('th', { class: 'foul' }, k === 1 ? 'ファウル 1' : String(k))))),
      h('tbody', null, team.players.map((p) => h('tr', { class: [!p.played && 'not-played'] },
        h('td', { class: 'num' }, p.number),
        h('td', { class: 'name' }, p.name),
        h('td', { class: 'in' }, p.starter ? h('span', { class: 'starter', title: '先発' }, '×') : p.played ? '×' : ''),
        [0, 1, 2, 3, 4].map((i) => {
          const q = p.fouls[i];
          return h('td', { class: ['foul', q && quarterInk(q), i === 4 && q && 'fifth'] }, q ? quarterLabel(q) : '');
        }))))));
}

function runningScore(sheet) {
  const top = Math.max(sheet.final.us, sheet.final.opp);
  const rows = 40;
  const blocks = Math.max(4, Math.ceil(top / rows));
  const ends = { us: new Map(), opp: new Map() };
  for (const team of ['us', 'opp']) {
    for (const [q, v] of Object.entries(sheet.teams[team].quarterEnd)) if (v > 0) ends[team].set(v, Number(q));
  }
  const cells = (team, n) => {
    const r = sheet.teams[team].running[n];
    const endQ = ends[team].get(n);
    const numCell = h('td', { class: ['rs-pl', team, r && r.kind === 'fg3' && 'fg3', r && quarterInk(r.quarter), endQ && 'q-end'] },
      r ? h('span', null, r.kind === 'adjust' ? '補' : r.player == null ? '?' : r.player) : '');
    const scoreCell = h('td', {
      class: ['rs-sc', team, r && r.kind, r && quarterInk(r.quarter), endQ && 'q-end'],
      title: r ? `${quarterLabel(r.quarter)} ${r.kind === 'ft' ? 'フリースロー' : r.kind === 'fg3' ? '3P' : r.kind === 'fg2' ? '2P' : '得点補正'}` : null,
    }, h('span', null, String(n)));
    return team === 'us' ? [numCell, scoreCell] : [scoreCell, numCell];
  };
  const blockEls = [];
  for (let b = 0; b < blocks; b++) {
    blockEls.push(h('table', { class: 'rs-block' },
      h('thead', null, h('tr', null, h('th', { colspan: 2 }, 'A'), h('th', { colspan: 2 }, 'B'))),
      h('tbody', null, Array.from({ length: rows }, (_, i) => {
        const n = b * rows + i + 1;
        return h('tr', null, cells('us', n), cells('opp', n));
      }))));
  }
  return h('div', { class: 'rs' }, blockEls);
}

export function sheetSection(game, events, settings) {
  const sheet = buildScoreSheet(game, events, flowOpts(settings));
  const nQ = sheet.quarters.length;
  const ot = (team) => sheet.byQuarter[team].slice(REGULAR_QUARTERS).reduce((a, b) => a + b, 0);
  return h('div', { class: 'sheet-section' },
    h('section', { class: 'card sheet' },
      h('div', { class: 'sheet-cols' },
        h('div', { class: 'sheet-left' },
          teamBlock('チームA', '自チーム', sheet.teams.us, nQ),
          teamBlock('チームB', game.opponent || '相手', sheet.teams.opp, nQ)),
        h('div', { class: 'sheet-right' },
          h('div', { class: 'sh-meta-title' }, 'ランニングスコア'),
          runningScore(sheet),
          h('table', { class: 'sh-score' },
            h('thead', null, h('tr', null, h('th', null, 'スコア'), [1, 2, 3, 4].map((q) => h('th', null, `${q}Q`)), h('th', null, '延長'), h('th', null, '最終'))),
            h('tbody', null,
              h('tr', null, h('th', null, 'A 自チーム'), [0, 1, 2, 3].map((i) => h('td', null, String(sheet.byQuarter.us[i] ?? 0))), h('td', null, String(ot('us'))), h('td', { class: 'final' }, String(sheet.final.us))),
              h('tr', null, h('th', null, `B ${game.opponent || '相手'}`), [0, 1, 2, 3].map((i) => h('td', null, String(sheet.byQuarter.opp[i] ?? 0))), h('td', null, String(ot('opp'))), h('td', { class: 'final' }, String(sheet.final.opp))))),
          h('p', { class: 'sh-winner' }, '勝者：', sheet.winner ? (sheet.winner === 'us' ? '自チーム' : game.opponent || '相手') : '引き分け（または試合中）'))),
      h('div', { class: 'sh-legend' },
        h('span', null, h('span', { class: 'lg-box fg2' }, '12'), '2P（数字に斜線）'),
        h('span', null, h('span', { class: 'lg-box fg3-pl' }, '7'), h('span', { class: 'lg-box fg2' }, '15'), '3P（背番号を○で囲む）'),
        h('span', null, h('span', { class: 'lg-box ft' }, '16'), 'フリースロー（●）'),
        h('span', null, h('span', { class: 'lg-box q-end' }, '20'), 'クォーターの終わり（下に太線）'),
        h('span', null, h('span', { class: 'lg-ink q-odd' }, '赤'), '1Q・3Q', h('span', { class: 'lg-ink q-even' }, '黒'), '2Q・4Q'),
        h('span', null, '出場の × は出た選手（○つきは先発）。タイムアウトの数字は何分目（時計なしは○）')),
      h('p', { class: 'muted small' }, 'ファウルの欄は、ファウルしたクォーターです（フリースローの本数は記録していないので、P1・P2 などは書きません）。')));
}
