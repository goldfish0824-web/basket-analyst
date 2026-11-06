// 試合時計（クォーターの残り時間のカウントダウン）。純粋関数。
// 記録者が ▶／❚❚ で動かしたり止めたりする。各イベントには記録した時点の残り秒数（clock）を付ける。
//
// clock = { quarter, length（秒）, remaining（止めた時点の残り秒）, runningSince（動かし始めた時刻 ms。止まっていれば null） }

export const DEFAULT_QUARTER_MIN = 10;
export const DEFAULT_OT_MIN = 5;

/** そのクォーターの長さ（秒）。延長は otMin 分 */
export function quarterSeconds(quarter, { quarterMin = DEFAULT_QUARTER_MIN, otMin = DEFAULT_OT_MIN, regular = 4 } = {}) {
  const min = quarter > regular ? otMin : quarterMin;
  const n = Number(min);
  return Math.round((Number.isFinite(n) && n > 0 ? n : quarter > regular ? DEFAULT_OT_MIN : DEFAULT_QUARTER_MIN) * 60);
}

export function newClock(quarter, length) {
  return { quarter, length, remaining: length, runningSince: null };
}

export function isRunning(clock) {
  return !!clock && clock.runningSince != null;
}

/** いまの残り秒（0 未満にはしない） */
export function remainingAt(clock, now) {
  if (!clock) return null;
  const base = Number(clock.remaining) || 0;
  const left = isRunning(clock) ? base - (now - clock.runningSince) / 1000 : base;
  return Math.max(0, left);
}

export function startClock(clock, now) {
  if (!clock || isRunning(clock) || remainingAt(clock, now) <= 0) return clock;
  return { ...clock, runningSince: now };
}

export function stopClock(clock, now) {
  if (!clock || !isRunning(clock)) return clock;
  return { ...clock, remaining: round1(remainingAt(clock, now)), runningSince: null };
}

/** 残り時間を合わせる（動いていれば動いたまま）。0〜クォーターの長さに収める */
export function setRemaining(clock, sec, now) {
  if (!clock) return clock;
  const v = Math.min(Math.max(0, Number(sec) || 0), clock.length);
  return { ...clock, remaining: round1(v), runningSince: isRunning(clock) && v > 0 ? now : null };
}

export function adjustClock(clock, delta, now) {
  if (!clock) return clock;
  return setRemaining(clock, remainingAt(clock, now) + delta, now);
}

/** 0 になっていたら止める（画面の更新のたびに呼ぶ） */
export function settleClock(clock, now) {
  if (isRunning(clock) && remainingAt(clock, now) <= 0) return { ...clock, remaining: 0, runningSince: null };
  return clock;
}

/** イベントに付ける残り秒（そのクォーターの時計がなければ null） */
export function clockForEvent(clock, quarter, now) {
  if (!clock || clock.quarter !== quarter) return null;
  return round1(remainingAt(clock, now));
}

/** 「9:59」「0:05」（秒の端数は切り上げ。10:00 から動かした直後は 9:59 ではなく 10:00 と出さないため） */
export function formatClock(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '';
  const total = Math.max(0, Math.ceil(Number(sec) - 1e-9));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 「12:34」→ 754 秒。「5」→ 300 秒（分だけ）。読めなければ null */
export function parseClock(text) {
  const t = String(text || '').trim().replace(/[０-９：]/g, (c) => (c === '：' ? ':' : String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
  let m = /^(\d{1,2}):(\d{1,2})$/.exec(t);
  if (m) {
    const s = Number(m[2]);
    return s < 60 ? Number(m[1]) * 60 + s : null;
  }
  m = /^(\d{1,2})$/.exec(t);
  return m ? Number(m[1]) * 60 : null;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}
