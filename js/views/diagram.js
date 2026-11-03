// 場面別Q&A の図（コート・選手・矢印）を SVG で描く
import { h, s } from '../ui.js';
import { arcPoint, CORNER_JOIN_DEG, BASKET, THREE_R, CORNER_Y, PAINT, FT_Y } from '../court.js';
import { courtSize, resolvePoint, legendKinds } from '../qa.js';

const M = 0.9; // 余白（m）
let uid = 0;

/** ハーフコート1面ぶんの線（ハーフコートの座標で） */
function halfCourtShapes() {
  const shapes = [];
  const poly = (pts, cls) => shapes.push({ type: 'poly', pts, cls });
  const arc = (cx, cy, r, from, to, cls, n = 32) => {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = ((from + ((to - from) * i) / n) * Math.PI) / 180;
      pts.push({ x: cx + r * Math.sin(a), y: cy + r * Math.cos(a) });
    }
    poly(pts, cls);
  };
  poly([{ x: PAINT.x1, y: 0 }, { x: PAINT.x1, y: PAINT.y2 }, { x: PAINT.x2, y: PAINT.y2 }, { x: PAINT.x2, y: 0 }], 'paint');
  // 3Pライン
  const pts = [{ x: 0.9, y: 0 }, { x: 0.9, y: CORNER_Y }];
  const n = 40;
  for (let i = 0; i <= n; i++) pts.push(arcPoint(-CORNER_JOIN_DEG + (2 * CORNER_JOIN_DEG * i) / n, THREE_R));
  pts.push({ x: 14.1, y: CORNER_Y }, { x: 14.1, y: 0 });
  poly(pts, '');
  // フリースローサークル（外側は実線、内側は破線）
  arc(7.5, FT_Y, 1.8, -90, 90, '');
  arc(7.5, FT_Y, 1.8, 90, 270, 'dash');
  // ノーチャージ半円・ボード・リング
  arc(BASKET.x, BASKET.y, 1.25, -90, 90, '');
  poly([{ x: 6.6, y: 1.2 }, { x: 8.4, y: 1.2 }], 'board');
  shapes.push({ type: 'circle', cx: BASKET.x, cy: BASKET.y, r: 0.225, cls: 'rim' });
  return shapes;
}

function toPath(pts) {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' ');
}

function drawCourt(svg, court) {
  const { w, hgt } = { w: courtSize(court).w, hgt: courtSize(court).h };
  const g = s('g', { class: 'dg-court' });
  g.appendChild(s('rect', { class: 'dg-floor', x: 0, y: 0, width: w, height: hgt }));
  const sides = court === 'full'
    ? [(p) => ({ x: p.y, y: p.x }), (p) => ({ x: 28 - p.y, y: p.x })] // 横向き：左右のゴール
    : [(p) => p];
  for (const map of sides) {
    for (const sh of halfCourtShapes()) {
      if (sh.type === 'poly') g.appendChild(s('path', { d: toPath(sh.pts.map(map)), class: `dg-line ${sh.cls}`.trim() }));
      else {
        const c = map({ x: sh.cx, y: sh.cy });
        g.appendChild(s('circle', { cx: c.x, cy: c.y, r: sh.r, class: `dg-line ${sh.cls}` }));
      }
    }
  }
  if (court === 'full') {
    g.appendChild(s('path', { d: 'M14 0 L14 15', class: 'dg-line' }));
    g.appendChild(s('circle', { cx: 14, cy: 7.5, r: 1.8, class: 'dg-line' }));
  } else {
    g.appendChild(s('path', { d: `M${7.5 - 1.8} 14 A1.8 1.8 0 0 1 ${7.5 + 1.8} 14`, class: 'dg-line' }));
  }
  g.appendChild(s('rect', { class: 'dg-line dg-edge', x: 0, y: 0, width: w, height: hgt }));
  svg.appendChild(g);
}

/** 2次ベジェ曲線上の点 */
function bez(a, c, b, t) {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

/** 矢印の線を点の列にする（via があれば曲線。corner なら via で折れる直線＝Vカットなど） */
function samplePath(a, b, via, corner = false, n = 48) {
  const pts = [];
  if (via && corner) {
    for (const [p, q] of [[a, via], [via, b]]) {
      for (let i = 0; i < n / 2; i++) pts.push({ x: p.x + ((q.x - p.x) * i) / (n / 2), y: p.y + ((q.y - p.y) * i) / (n / 2) });
    }
    pts.push(b);
    return pts;
  }
  const c = via || { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  for (let i = 0; i <= n; i++) pts.push(bez(a, c, b, i / n));
  return pts;
}

/** 選手の円の外側から始め、円の手前で終わるように端を詰める */
function trim(pts, startGap, endGap) {
  const len = (p, q) => Math.hypot(q.x - p.x, q.y - p.y);
  let i = 0;
  let acc = 0;
  while (i < pts.length - 1 && acc + len(pts[i], pts[i + 1]) < startGap) {
    acc += len(pts[i], pts[i + 1]);
    i += 1;
  }
  let j = pts.length - 1;
  acc = 0;
  while (j > i + 1 && acc + len(pts[j - 1], pts[j]) < endGap) {
    acc += len(pts[j - 1], pts[j]);
    j -= 1;
  }
  return pts.slice(i, j + 1);
}

function zigzag(pts) {
  // ドリブル：線に沿ってジグザグ。最後の 0.6m はまっすぐ（矢じりのため）
  const out = [pts[0]];
  let dist = 0;
  let side = 1;
  let next = 0.3;
  const total = pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    const seg = Math.hypot(q.x - p.x, q.y - p.y);
    while (dist + seg >= next && next < total - 0.6) {
      const t = (next - dist) / seg;
      const nx = -(q.y - p.y) / seg;
      const ny = (q.x - p.x) / seg;
      out.push({ x: p.x + (q.x - p.x) * t + nx * 0.2 * side, y: p.y + (q.y - p.y) * t + ny * 0.2 * side });
      side = -side;
      next += 0.3;
    }
    dist += seg;
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function isPlayerRef(ref) {
  return typeof ref === 'string';
}

/**
 * 図を描く。d は qa-data.js の diagram。
 * 戻り値は <figure>（SVG と凡例）。opts.thumb なら凡例なしの小さな図。
 */
export function renderDiagram(d, { thumb = false, caption = '' } = {}) {
  const { w, h: hgt } = courtSize(d.court);
  const id = `dg${++uid}`;
  const svg = s('svg', {
    class: ['diagram', d.court === 'full' ? 'full' : 'half', thumb ? 'thumb' : ''].filter(Boolean).join(' '),
    viewBox: `${-M} ${-M} ${w + 2 * M} ${hgt + 2 * M}`,
    role: 'img',
    'aria-label': caption || '図',
  });
  svg.appendChild(s('defs', null,
    s('marker', { id: `${id}-head`, viewBox: '0 0 10 10', refX: 7, refY: 5, markerWidth: 4.2, markerHeight: 4.2, orient: 'auto-start-reverse' },
      s('path', { d: 'M0 0 L10 5 L0 10 z', class: 'dg-head' }))));
  drawCourt(svg, d.court);

  // わな などの範囲
  for (const ar of d.areas || []) {
    const pts = ar.points.map(([x, y]) => ({ x, y }));
    svg.appendChild(s('path', { d: `${toPath(pts)} Z`, class: 'dg-area' }));
    if (ar.label && !thumb) {
      const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
      svg.appendChild(s('text', { x: cx, y: cy + 0.18, class: 'dg-area-label' }, ar.label));
    }
  }
  // 補助線
  for (const g of d.guides || []) {
    const a = resolvePoint(d, g.from);
    const b = resolvePoint(d, g.to);
    svg.appendChild(s('path', { d: toPath([a, b]), class: 'dg-guide' }));
  }

  // 矢印（選手の下に描く）
  const arrows = s('g', { class: 'dg-arrows' });
  for (const a of d.arrows || []) {
    const from = resolvePoint(d, a.from);
    const to = resolvePoint(d, a.to);
    const via = a.via ? resolvePoint(d, a.via) : null;
    let pts = samplePath(from, to, via, a.corner === true);
    pts = trim(pts, isPlayerRef(a.from) ? 0.62 : 0.05, isPlayerRef(a.to) ? 0.7 : 0.05);
    if (pts.length < 2) continue;
    if (a.kind === 'screen') {
      const end = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      const len = Math.hypot(end.x - prev.x, end.y - prev.y) || 1;
      const nx = -(end.y - prev.y) / len;
      const ny = (end.x - prev.x) / len;
      arrows.appendChild(s('path', { d: toPath(pts), class: 'dg-arrow screen' }));
      arrows.appendChild(s('path', { d: toPath([{ x: end.x + nx * 0.5, y: end.y + ny * 0.5 }, { x: end.x - nx * 0.5, y: end.y - ny * 0.5 }]), class: 'dg-arrow screen bar' }));
      continue;
    }
    const line = a.kind === 'dribble' ? zigzag(pts) : pts;
    arrows.appendChild(s('path', { d: toPath(line), class: `dg-arrow ${a.kind}`, 'marker-end': `url(#${id}-head)` }));
  }
  svg.appendChild(arrows);

  // 選手：攻め＝●、守り＝▲
  const players = s('g', { class: 'dg-players' });
  for (const [x, y, label] of d.defense || []) {
    const r = 0.62;
    const tri = `M${x} ${y - r} L${x + r * 0.95} ${y + r * 0.62} L${x - r * 0.95} ${y + r * 0.62} Z`;
    players.appendChild(s('path', { d: tri, class: 'dg-def' }));
    players.appendChild(s('text', { x, y: y + 0.36, class: 'dg-num def' }, label));
  }
  for (const [x, y, label] of d.offense || []) {
    players.appendChild(s('circle', { cx: x, cy: y, r: 0.55, class: 'dg-off' }));
    players.appendChild(s('text', { x, y: y + 0.2, class: 'dg-num off' }, label));
  }
  const ball = d.ball ? resolvePoint(d, d.ball) : null;
  // ボールは選手の右上（コートの上端の外にいる選手は右下）
  if (ball) players.appendChild(s('circle', { cx: ball.x + 0.52, cy: ball.y < 0.4 ? ball.y + 0.48 : ball.y - 0.48, r: 0.24, class: 'dg-ball' }));
  svg.appendChild(players);

  if (!thumb) {
    for (const l of d.labels || []) svg.appendChild(s('text', { x: l.at[0], y: l.at[1], class: 'dg-label' }, l.text));
  }
  if (thumb) return svg;

  const LABEL = { offense: '攻め', defense: '守り', move: '移動', pass: 'パス', dribble: 'ドリブル', screen: 'スクリーン', ball: 'ボール' };
  const kinds = legendKinds(d);
  if (ball) kinds.push('ball');
  return h('figure', { class: 'dg-figure' },
    svg,
    h('figcaption', null,
      caption ? h('p', { class: 'dg-caption' }, caption) : null,
      h('ul', { class: 'dg-legend' }, kinds.map((k) => h('li', null, legendIcon(k), LABEL[k])))));
}

/** 凡例の小さな見本 */
function legendIcon(kind) {
  const svg = s('svg', { class: 'dg-lg', viewBox: '0 0 30 16', 'aria-hidden': 'true' });
  if (kind === 'offense') svg.appendChild(s('circle', { cx: 15, cy: 8, r: 6.5, class: 'dg-off' }));
  else if (kind === 'defense') svg.appendChild(s('path', { d: 'M15 1 L22 14 L8 14 Z', class: 'dg-def' }));
  else if (kind === 'ball') svg.appendChild(s('circle', { cx: 15, cy: 8, r: 4.5, class: 'dg-ball lg' }));
  else if (kind === 'screen') {
    svg.appendChild(s('path', { d: 'M2 8 L24 8', class: 'dg-lg-line' }));
    svg.appendChild(s('path', { d: 'M24 2 L24 14', class: 'dg-lg-line bar' }));
  } else {
    const d = kind === 'dribble' ? 'M2 8 L5 5 L8 11 L11 5 L14 11 L17 5 L20 8 L27 8' : 'M2 8 L27 8';
    svg.appendChild(s('path', { d, class: `dg-lg-line ${kind}` }));
    svg.appendChild(s('path', { d: 'M23 4 L28 8 L23 12 Z', class: 'dg-lg-head' }));
  }
  return svg;
}
