// ハーフコート図（画面の上がゴール）。記録画面と集計画面で共通。
import { s, clear } from './ui.js';
import {
  COURT_W, COURT_H, BASKET, THREE_R, CORNER_Y, PAINT, FT_Y, CORNER_JOIN_DEG, arcPoint, zonePolygons,
  ZONES, ZONE_LABEL_POS, ZONE_LABELS, clampToCourt,
} from './court.js';
import { pctText } from './stats.js';
import { describeEvent, quarterLabel } from './model.js';

const M = 0.45; // 余白（m）

function pathFrom(points, close = true) {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' ') + (close ? ' Z' : '');
}

function threePointPath() {
  const a = arcPoint(-CORNER_JOIN_DEG);
  const b = arcPoint(CORNER_JOIN_DEG);
  // 左コーナー直線 → 弧 → 右コーナー直線
  return `M0.9 0 L0.9 ${CORNER_Y} L${a.x.toFixed(3)} ${a.y.toFixed(3)} A${THREE_R} ${THREE_R} 0 0 0 ${b.x.toFixed(3)} ${b.y.toFixed(3)} L14.1 ${CORNER_Y} L14.1 0`;
}

/**
 * コート図の SVG を作る。
 * opts = { onTap(x, y), label }
 * 戻り値 = { svg, layers: { zones, shots, overlay, pending } }
 */
export function createCourt({ onTap, label = 'ハーフコート' } = {}) {
  const svg = s('svg', {
    class: 'court',
    viewBox: `${-M} ${-M} ${COURT_W + 2 * M} ${COURT_H + 2 * M}`,
    role: onTap ? 'application' : 'img',
    'aria-label': label,
    preserveAspectRatio: 'xMidYMid meet',
  });
  const lines = s('g', { class: 'court-lines' });
  lines.append(
    s('rect', { class: 'court-floor', x: 0, y: 0, width: COURT_W, height: COURT_H }),
    s('rect', { class: 'court-paint', x: PAINT.x1, y: 0, width: PAINT.x2 - PAINT.x1, height: PAINT.y2 }),
    s('path', { d: threePointPath() }),
    // フリースローサークル（上半分は実線、下半分は破線）
    s('path', { d: `M${7.5 - 1.8} ${FT_Y} A1.8 1.8 0 0 0 ${7.5 + 1.8} ${FT_Y}` }),
    s('path', { class: 'dash', d: `M${7.5 - 1.8} ${FT_Y} A1.8 1.8 0 0 1 ${7.5 + 1.8} ${FT_Y}` }),
    // ノーチャージ半円
    s('path', { d: `M${BASKET.x - 1.25} ${BASKET.y} A1.25 1.25 0 0 0 ${BASKET.x + 1.25} ${BASKET.y}` }),
    // センターサークル（半分）
    s('path', { d: `M${7.5 - 1.8} ${COURT_H} A1.8 1.8 0 0 1 ${7.5 + 1.8} ${COURT_H}` }),
    s('line', { class: 'board', x1: 6.6, y1: 1.2, x2: 8.4, y2: 1.2 }),
    s('circle', { class: 'rim', cx: BASKET.x, cy: BASKET.y, r: 0.225 }),
    s('rect', { class: 'court-edge', x: 0, y: 0, width: COURT_W, height: COURT_H }),
  );
  const zones = s('g', { class: 'court-zones' });
  const shots = s('g', { class: 'court-shots' });
  const overlay = s('g', { class: 'court-overlay' });
  const pending = s('g', { class: 'court-pending' });
  svg.append(lines, zones, shots, overlay, pending);

  if (onTap) {
    svg.addEventListener('click', (ev) => {
      const p = toCourt(svg, ev.clientX, ev.clientY);
      if (p) onTap(p.x, p.y);
    });
  }
  return { svg, layers: { zones, shots, overlay, pending } };
}

/** 画面上の位置 → コート座標（m）。コートの外は内側に寄せる。 */
export function toCourt(svg, clientX, clientY) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const p = pt.matrixTransform(ctm.inverse());
  const c = clampToCourt(p.x, p.y);
  return { x: Math.round(c.x * 100) / 100, y: Math.round(c.y * 100) / 100 };
}

/** ゾーンの境界（破線） */
export function drawZoneLines(layer) {
  clear(layer);
  const polys = zonePolygons();
  for (const z of ZONES) layer.appendChild(s('path', { class: 'zone-line', d: pathFrom(polys[z]) }));
}

/**
 * シュートの印。成功＝○、失敗＝×。色はチーム（自＝青、相手＝橙）。
 * opts = { faded, highlightId, onSelect(e) }
 */
export function drawShots(layer, shots, opts = {}) {
  clear(layer);
  const halo = s('g', { class: 'shot-halo' });
  const marks = s('g', { class: 'shot-marks' });
  layer.append(halo, marks);
  for (const e of shots) {
    if (e.x == null || e.y == null) continue;
    const cls = ['shot', e.team === 'opp' ? 'opp' : 'us', e.made ? 'made' : 'miss', opts.faded ? 'faded' : '', e.id === opts.highlightId ? 'last' : '']
      .filter(Boolean)
      .join(' ');
    const r = 0.26;
    const d = 0.22;
    const title = s('title', null, `${quarterLabel(e.quarter)} ${describeEvent(e, ZONE_LABELS)}`);
    if (e.made) {
      halo.appendChild(s('circle', { cx: e.x, cy: e.y, r, class: 'halo' }));
      marks.appendChild(s('circle', { cx: e.x, cy: e.y, r, class: cls }, title));
    } else {
      const x = `M${e.x - d} ${e.y - d} L${e.x + d} ${e.y + d} M${e.x + d} ${e.y - d} L${e.x - d} ${e.y + d}`;
      halo.appendChild(s('path', { d: x, class: 'halo' }));
      marks.appendChild(s('path', { d: x, class: cls }, title));
    }
    if (opts.onSelect) {
      // 印より大きいタップ領域
      marks.appendChild(
        s('circle', {
          cx: e.x, cy: e.y, r: 0.55, class: 'shot-hit',
          onclick: (ev) => { ev.stopPropagation(); opts.onSelect(e); },
        }),
      );
    }
  }
}

/** ゾーンごとの「成功-試投・%」 */
export function drawZoneStats(layer, stats) {
  clear(layer);
  for (const z of ZONES) {
    const st = stats[z];
    if (!st) continue;
    const p = ZONE_LABEL_POS[z];
    const corner = z.endsWith('コーナー');
    const w = corner ? 1.2 : 1.7;
    const hgt = 1.02;
    // コーナーは幅0.9mしかないので、ラベルをコート内側に少しずらす
    const cx = corner ? (p.x < 7.5 ? 0.6 : COURT_W - 0.6) : p.x;
    const g = s('g', { class: ['zone-label', st.att ? '' : 'empty'].join(' ') });
    g.append(
      s('rect', { x: cx - w / 2, y: p.y - hgt / 2, width: w, height: hgt, rx: 0.16 }),
      s('text', { x: cx, y: p.y - 0.06, class: 'zl-ma' }, `${st.made}-${st.att}`),
      s('text', { x: cx, y: p.y + 0.38, class: 'zl-pct' }, st.att ? pctText(st.made, st.att) : '—'),
    );
    layer.appendChild(g);
  }
}

/** 記録中のシュート位置（選手・結果待ち） */
export function drawPending(layer, loc, { three, team } = {}) {
  clear(layer);
  if (!loc) return;
  const g = s('g', { class: ['pending', team === 'opp' ? 'opp' : 'us'].join(' ') });
  g.append(
    s('circle', { cx: loc.x, cy: loc.y, r: 0.5, class: 'pulse' }),
    s('circle', { cx: loc.x, cy: loc.y, r: 0.12, class: 'dot' }),
    s('text', { x: loc.x, y: loc.y - 0.7, class: 'pending-label' }, three ? '3P' : '2P'),
  );
  layer.appendChild(g);
}
