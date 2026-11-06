// 出場メンバー（コートにいる5人）と、出場時間・+/-。純粋関数。
// ・試合の最初に「出場メンバー」（lineup：5人）を記録し、その後は「交代」（sub：out → player）で入れ替える
// ・いまコートにいる5人は、イベントを順にたどって求める（取り消し・削除をしても自然に戻る）
import { pointsScored } from './stats.js';

export const COURT_SIZE = 5;

function bySeq(events) {
  return [...events].sort((a, b) => a.seq - b.seq);
}

/** 交代を1つ当てはめる（出る選手の位置に入る選手を置く） */
function applySub(court, out, inn) {
  if (!court || inn == null) return court;
  if (court.includes(inn)) return court;
  const i = court.indexOf(out);
  if (i >= 0) {
    const next = [...court];
    next[i] = inn;
    return next;
  }
  return court.length < COURT_SIZE ? [...court, inn] : court;
}

/**
 * いまコートにいる選手（背番号の配列。並びは出場メンバーを決めたときの順で、交代した位置に入る）。
 * 出場メンバーを記録していなければ null。
 */
export function onCourt(events, team = 'us') {
  let court = null;
  for (const e of bySeq(events)) {
    if (e.team !== team) continue;
    if (e.type === 'lineup') court = (e.players || []).map(String);
    else if (e.type === 'sub') court = applySub(court, e.out == null ? null : String(e.out), e.player == null ? null : String(e.player));
  }
  return court;
}

/** ベンチ（名簿のうちコートにいない選手。名簿の順） */
export function benchOf(roster, court) {
  const on = new Set(court || []);
  return roster.map((p) => String(p.number)).filter((n) => !on.has(n));
}

/**
 * 交代の前後（コートの5人）から、記録する交代の組を作る。
 * 出た選手はコートでの位置の順、入った選手は選んだ順に組にする。
 */
export function swapPlan(before, after) {
  const b = (before || []).map(String);
  const a = (after || []).map(String);
  const outs = b.filter((n) => !a.includes(n));
  const ins = a.filter((n) => !b.includes(n));
  const pairs = [];
  for (let i = 0; i < Math.min(outs.length, ins.length); i++) pairs.push({ out: outs[i], in: ins[i] });
  return pairs;
}

/**
 * 出場時間（秒）と +/-（コートにいる間の得失点差）。
 * 時間は各イベントの残り秒（clock）の差から数える。時計を使っていない試合は seconds を null にする。
 * 戻り値 { tracked, hasClock, seconds: {背番号: 秒}, plusMinus: {背番号: 点} }
 */
export function playingTime(events, team = 'us') {
  const seconds = {};
  const plusMinus = {};
  let court = null;
  let tracked = false;
  let hasClock = false;
  let quarter = null;
  let last = null; // 直前の残り秒
  const credit = (to) => {
    if (!court || last == null || to == null) return;
    const d = last - to;
    if (d > 0) for (const p of court) seconds[p] = (seconds[p] || 0) + d;
    last = to;
  };
  const touch = (list) => {
    for (const p of list || []) {
      if (!(p in seconds)) seconds[p] = 0;
      if (!(p in plusMinus)) plusMinus[p] = 0;
    }
  };
  for (const e of bySeq(events)) {
    if (e.type === 'q_start') {
      quarter = e.quarter;
      last = e.clock == null ? null : Number(e.clock);
      if (last != null) hasClock = true;
      continue;
    }
    if (quarter != null && e.quarter === quarter && e.clock != null) credit(Number(e.clock));
    if (e.type === 'q_end') {
      quarter = null;
      last = null;
      continue;
    }
    if (e.team === team && e.type === 'lineup') {
      court = (e.players || []).map(String);
      tracked = true;
      touch(court);
      continue;
    }
    if (e.team === team && e.type === 'sub') {
      court = applySub(court, e.out == null ? null : String(e.out), e.player == null ? null : String(e.player));
      touch(court);
      continue;
    }
    const pts = pointsScored(e);
    if (pts && court && (e.team === 'us' || e.team === 'opp')) {
      for (const p of court) plusMinus[p] = (plusMinus[p] || 0) + (e.team === team ? pts : -pts);
    }
  }
  for (const k of Object.keys(seconds)) seconds[k] = Math.round(seconds[k] * 10) / 10;
  return { tracked, hasClock, seconds: hasClock ? seconds : null, plusMinus };
}

/** 出場時間の表示「12:34」 */
export function minutesText(sec) {
  if (sec == null) return '—';
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 名簿に背番号を足す（同じ番号があれば足さない）。背番号の順に並べ直さず、最後に足す */
export function addToRoster(roster, number, name = '') {
  const n = String(number).trim();
  if (!/^\d{1,2}$/.test(n)) return { roster, error: '背番号は0〜99の数字で入力してください' };
  if (roster.some((p) => String(p.number) === n)) return { roster, error: `#${n} はもう名簿にいます` };
  return { roster: [...roster, { number: n, name: String(name || '').trim().slice(0, 12) }] };
}

/** 出場メンバーの候補（先発を選ぶ画面の初期値）：名簿の先頭から5人 */
export function defaultStarters(roster) {
  return roster.slice(0, COURT_SIZE).map((p) => String(p.number));
}
