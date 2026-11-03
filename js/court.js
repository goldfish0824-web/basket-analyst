// コートの寸法とゾーン判定（SPEC 3-4）。すべて純粋関数。
// 座標はメートル。x：0〜15（左サイドラインが0）、y：0〜14（エンドラインが0）。
// 左右はオフェンスから見た向き（ゴールに向かって右＝x が大きい側）。

export const COURT_W = 15;
export const COURT_H = 14;
export const BASKET = { x: 7.5, y: 1.575 };
export const THREE_R = 6.75;
export const CORNER_DX = 6.6; // ゴール中心から横に 6.6m（サイドラインから 0.9m）
export const CORNER_Y = 2.99; // 直線部分は y ≦ 2.99
export const PAINT = { x1: 5.05, x2: 9.95, y1: 0, y2: 5.8 };
export const FT_Y = 5.8;
export const TOP_ANGLE_DEG = 22.5;

export const ZONES = [
  'ゴール下',
  'ミドル左',
  'ミドル中央',
  'ミドル右',
  '3P左コーナー',
  '3P左45度',
  '3Pトップ',
  '3P右45度',
  '3P右コーナー',
];

export const THREE_ZONES = ['3P左コーナー', '3P左45度', '3Pトップ', '3P右45度', '3P右コーナー'];

// 画面に出す短い名前（SPEC：表示文言は「右45度」「左コーナー」など）
export const ZONE_LABELS = {
  'ゴール下': 'ゴール下',
  'ミドル左': 'ミドル左',
  'ミドル中央': 'ミドル中央',
  'ミドル右': 'ミドル右',
  '3P左コーナー': '左コーナー',
  '3P左45度': '左45度',
  '3Pトップ': 'トップ',
  '3P右45度': '右45度',
  '3P右コーナー': '右コーナー',
};

export function clampToCourt(x, y) {
  return {
    x: Math.min(COURT_W, Math.max(0, x)),
    y: Math.min(COURT_H, Math.max(0, y)),
  };
}

export function inPaint(x, y) {
  return x >= PAINT.x1 && x <= PAINT.x2 && y >= PAINT.y1 && y <= PAINT.y2;
}

/** 3Pラインの外側か（ライン上は2P）。 */
export function isThree(x, y) {
  const dx = x - BASKET.x;
  if (y <= CORNER_Y) return Math.abs(dx) > CORNER_DX;
  const dy = y - BASKET.y;
  return Math.hypot(dx, dy) > THREE_R;
}

/** ゴール中心から見た角度（度）。正面（+y方向）が0、左右どちらも正の値。 */
export function angleFromFront(x, y) {
  const dx = Math.abs(x - BASKET.x);
  const dy = y - BASKET.y;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

function sideOf(x) {
  return x < BASKET.x ? '左' : '右';
}

function threeZoneOf(x, y) {
  if (y <= CORNER_Y) return `3P${sideOf(x)}コーナー`;
  if (angleFromFront(x, y) <= TOP_ANGLE_DEG) return '3Pトップ';
  return `3P${sideOf(x)}45度`;
}

function twoZoneOf(x, y) {
  if (inPaint(x, y)) return 'ゴール下';
  if (x < PAINT.x1) return 'ミドル左';
  if (x > PAINT.x2) return 'ミドル右';
  return 'ミドル中央';
}

/**
 * ゾーンを返す。
 * three を true/false で渡すと、記録者が「2P⇄3P」を切り替えた結果に合わせて
 * 3P側／2P側のゾーンに寄せる（境界付近の誤判定の補正用）。
 */
export function zoneOf(x, y, three) {
  const useThree = typeof three === 'boolean' ? three : isThree(x, y);
  // 3P：y≦2.99 ならコーナー、それ以外はゴール中心から見た角度でトップ／45度。
  //     （自動判定で3Pなら y≦2.99 の点は必ず横6.6m超なので SPEC の表と一致する）
  // 2P：ペイント内はゴール下、それ以外は x で左／中央／右。
  return useThree ? threeZoneOf(x, y) : twoZoneOf(x, y);
}

export function pointsForZone(zone) {
  return THREE_ZONES.includes(zone) ? 3 : 2;
}

// ---- 描画用の形（court-svg.js とテストで使う） ----

/** 3Pラインの弧上の点（ゴール中心からの角度 deg。正面0、左が負、右が正）。 */
export function arcPoint(deg, r = THREE_R) {
  const rad = (deg * Math.PI) / 180;
  return { x: BASKET.x + r * Math.sin(rad), y: BASKET.y + r * Math.cos(rad) };
}

/** 弧とコーナー直線の接続点の角度（約 77.9 度）。 */
export const CORNER_JOIN_DEG = (Math.atan2(CORNER_DX, CORNER_Y - BASKET.y) * 180) / Math.PI;

function arcPoints(fromDeg, toDeg, steps = 24) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const d = fromDeg + ((toDeg - fromDeg) * i) / steps;
    pts.push(arcPoint(d));
  }
  return pts;
}

/** 弧が x = c と交わる角度（c は弧の範囲内）。 */
function arcDegAtX(c) {
  return (Math.asin((c - BASKET.x) / THREE_R) * 180) / Math.PI;
}

/** 正面から deg の方向の半直線が y = 14 と交わる点。 */
function rayToHalfLine(deg) {
  const rad = (deg * Math.PI) / 180;
  const t = (COURT_H - BASKET.y) / Math.cos(rad);
  return { x: BASKET.x + t * Math.sin(rad), y: COURT_H };
}

/** 各ゾーンの多角形（ゾーン別成績の色分け・境界表示に使う）。 */
export function zonePolygons() {
  const J = CORNER_JOIN_DEG;
  const T = TOP_ANGLE_DEG;
  const dL = arcDegAtX(PAINT.x1); // 負の角度
  const dR = arcDegAtX(PAINT.x2);
  const rayL = rayToHalfLine(-T);
  const rayR = rayToHalfLine(T);
  return {
    'ゴール下': [
      { x: PAINT.x1, y: 0 }, { x: PAINT.x2, y: 0 }, { x: PAINT.x2, y: PAINT.y2 }, { x: PAINT.x1, y: PAINT.y2 },
    ],
    'ミドル左': [
      { x: 0.9, y: 0 }, { x: PAINT.x1, y: 0 }, { x: PAINT.x1, y: arcPoint(dL).y },
      ...arcPoints(dL, -J), { x: 0.9, y: CORNER_Y },
    ],
    'ミドル右': [
      { x: PAINT.x2, y: 0 }, { x: 14.1, y: 0 }, { x: 14.1, y: CORNER_Y },
      ...arcPoints(J, dR), { x: PAINT.x2, y: arcPoint(dR).y },
    ],
    'ミドル中央': [
      { x: PAINT.x1, y: FT_Y }, { x: PAINT.x2, y: FT_Y }, ...arcPoints(dR, dL),
    ],
    '3P左コーナー': [{ x: 0, y: 0 }, { x: 0.9, y: 0 }, { x: 0.9, y: CORNER_Y }, { x: 0, y: CORNER_Y }],
    '3P右コーナー': [{ x: 14.1, y: 0 }, { x: COURT_W, y: 0 }, { x: COURT_W, y: CORNER_Y }, { x: 14.1, y: CORNER_Y }],
    '3P左45度': [
      { x: 0, y: CORNER_Y }, ...arcPoints(-J, -T), rayL, { x: 0, y: COURT_H },
    ],
    '3Pトップ': [...arcPoints(-T, T), rayR, rayL],
    '3P右45度': [
      ...arcPoints(T, J), { x: COURT_W, y: CORNER_Y }, { x: COURT_W, y: COURT_H }, rayR,
    ],
  };
}

/** ゾーン別成績のラベルを置く位置。 */
export const ZONE_LABEL_POS = {
  'ゴール下': { x: 7.5, y: 3.7 },
  'ミドル左': { x: 3.1, y: 2.6 },
  'ミドル中央': { x: 7.5, y: 7.0 },
  'ミドル右': { x: 11.9, y: 2.6 },
  '3P左コーナー': { x: 0.45, y: 1.5 },
  '3P右コーナー': { x: 14.55, y: 1.5 },
  '3P左45度': { x: 1.9, y: 9.0 },
  '3Pトップ': { x: 7.5, y: 11.2 },
  '3P右45度': { x: 13.1, y: 9.0 },
};
