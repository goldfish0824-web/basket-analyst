// 試合の流れ（得点の推移）と、両チームの比較・スコアシート。すべて純粋関数。
import { pointsScored, maxQuarter, inQuarterRange, scoreByQuarter, scoreOf } from './stats.js';
import { REGULAR_QUARTERS, sortNumbers } from './model.js';
import { quarterSeconds } from './clock.js';

function bySeq(events) {
  return [...events].sort((a, b) => a.seq - b.seq);
}

// ---- 試合の流れ（得点の推移） ----

/**
 * 得点の推移。x は試合の経過秒（クォーターの長さで並べる）。
 * 試合時計の残り秒（clock）がある記録はその時刻、ない記録はそのクォーターの中に記録の順で均等に並べる。
 * opts = { quarterMin, otMin }
 * 戻り値 { quarters: [{ q, start, end }], points: [{ t, quarter, clock, team, pts, us, opp, player }],
 *          timeouts: [{ t, quarter, clock, team, us, opp }], total, maxScore }
 */
export function scoreFlow(events, opts = {}) {
  const n = maxQuarter(events);
  const quarters = [];
  let start = 0;
  for (let q = 1; q <= n; q++) {
    const len = quarterSeconds(q, { ...opts, regular: REGULAR_QUARTERS });
    quarters.push({ q, start, end: start + len, len });
    start += len;
  }
  const marked = bySeq(events).filter((e) => e.quarter && (pointsScored(e) > 0 || e.type === 'timeout'));
  const timeOf = new Map();
  for (const qi of quarters) {
    const list = marked.filter((e) => e.quarter === qi.q);
    list.forEach((e, k) => {
      const c = e.clock != null && Number.isFinite(Number(e.clock)) ? Math.min(qi.len, Math.max(0, Number(e.clock))) : null;
      timeOf.set(e, c != null ? qi.start + (qi.len - c) : qi.start + (qi.len * (k + 1)) / (list.length + 1));
    });
  }
  const score = { us: 0, opp: 0 };
  const points = [];
  const timeouts = [];
  for (const e of marked) {
    if (e.team !== 'us' && e.team !== 'opp') continue;
    const t = timeOf.get(e);
    if (e.type === 'timeout') {
      timeouts.push({ t, quarter: e.quarter, clock: e.clock ?? null, team: e.team, us: score.us, opp: score.opp });
      continue;
    }
    const pts = pointsScored(e);
    score[e.team] += pts;
    points.push({ t, quarter: e.quarter, clock: e.clock ?? null, team: e.team, pts, us: score.us, opp: score.opp, player: e.player ?? null, type: e.type });
  }
  return { quarters, points, timeouts, total: start, maxScore: Math.max(score.us, score.opp) };
}

/** ある時刻（経過秒）の得点 */
export function scoreAt(flow, t) {
  let s = { us: 0, opp: 0 };
  for (const p of flow.points) {
    if (p.t > t) break;
    s = { us: p.us, opp: p.opp };
  }
  return s;
}

/** 経過秒 → 「2Q 残り5:32」の形にするための { quarter, left } */
export function quarterAt(flow, t) {
  const qi = flow.quarters.find((x) => t >= x.start && t <= x.end) || flow.quarters[flow.quarters.length - 1];
  if (!qi) return { quarter: 1, left: 0 };
  return { quarter: qi.q, left: Math.max(0, qi.end - t) };
}

// ---- 両チームの比較 ----

function emptyCompare() {
  return {
    pts: 0, twoM: 0, twoA: 0, threeM: 0, threeA: 0, ftM: 0, ftA: 0, fgM: 0, fgA: 0,
    oreb: 0, dreb: 0, teamReb: 0, ast: 0, stl: 0, blk: 0, to: 0, pf: 0, timeouts: 0,
  };
}

/**
 * 両チームの比較（2P・3P・FT の成功-試投、リバウンド、ターンオーバー、ファウル、タイムアウトなど）。
 * range：'all' | クォーター番号 | 'H1' | 'H2' | 'OT'
 * チームリバウンドは、選手を選ばずに記録したリバウンド。
 */
export function teamCompare(events, range = 'all') {
  const out = { us: emptyCompare(), opp: emptyCompare() };
  for (const e of events) {
    const t = out[e.team];
    if (!t || !inQuarterRange(e.quarter, range)) continue;
    t.pts += pointsScored(e);
    switch (e.type) {
      case 'fg':
        t.fgA += 1;
        if (e.made) t.fgM += 1;
        if (e.points === 3) {
          t.threeA += 1;
          if (e.made) t.threeM += 1;
        } else {
          t.twoA += 1;
          if (e.made) t.twoM += 1;
        }
        break;
      case 'ft':
        t.ftA += 1;
        if (e.made) t.ftM += 1;
        break;
      case 'oreb':
      case 'dreb':
        if (e.type === 'oreb') t.oreb += 1;
        else t.dreb += 1;
        if (e.player == null) t.teamReb += 1;
        break;
      case 'ast': t.ast += 1; break;
      case 'stl': t.stl += 1; break;
      case 'blk': t.blk += 1; break;
      case 'to': t.to += 1; break;
      case 'foul': t.pf += 1; break;
      case 'timeout': t.timeouts += 1; break;
      default: break;
    }
  }
  return out;
}

/** 成功率（%、整数）。試投 0 なら null */
export function pct(made, att) {
  return att ? Math.round((made / att) * 100) : null;
}

// ---- スコアシート（FIBA の様式に近い形） ----

/** 経過した分（その分の中で起きた＝「何分目」）。時計がなければ null */
export function playingMinute(clock, len) {
  if (clock == null || !Number.isFinite(Number(clock))) return null;
  const elapsed = Math.max(0, len - Number(clock));
  return Math.min(Math.ceil(len / 60), Math.max(1, Math.ceil(elapsed / 60)));
}

/**
 * スコアシートの中身。
 * game：試合（roster・oppNumbers）。opts = { quarterMin, otMin }
 * 戻り値 { teams: { us, opp }, quarters, byQuarter, final, winner }
 *   team = {
 *     players: [{ number, name, starter, played, fouls: [quarter...] }],
 *     timeouts: { h1: [分|null], h2: [...], ot: [...] },
 *     teamFouls: [1Q, 2Q, 3Q, 4Q]（延長は4Qの続き）,
 *     running: { 得点: { kind: 'ft'|'fg2'|'fg3'|'adjust', player, quarter } },
 *     quarterEnd: { クォーター: その時点の得点 },
 *   }
 */
export function buildScoreSheet(game, events, opts = {}) {
  const sorted = bySeq(events);
  const n = maxQuarter(events);
  const lenOf = (q) => quarterSeconds(q, { ...opts, regular: REGULAR_QUARTERS });
  const firstLineup = { us: null, opp: null };
  const subbedIn = { us: new Set(), opp: new Set() };
  const active = { us: new Set(), opp: new Set() };
  for (const e of sorted) {
    if (e.team !== 'us' && e.team !== 'opp') continue;
    if (e.type === 'lineup' && !firstLineup[e.team]) firstLineup[e.team] = (e.players || []).map(String);
    else if (e.type === 'sub' && e.player != null) subbedIn[e.team].add(String(e.player));
    else if (e.player != null && e.type !== 'lineup') active[e.team].add(String(e.player));
  }

  const make = (team, list) => {
    const starters = new Set(firstLineup[team] || []);
    const fouls = new Map(list.map((p) => [p.number, []]));
    const extra = [];
    for (const e of sorted) {
      if (e.team !== team || e.type !== 'foul' || e.player == null) continue;
      const k = String(e.player);
      if (!fouls.has(k)) {
        fouls.set(k, []);
        extra.push(k);
      }
      fouls.get(k).push(e.quarter);
    }
    const players = [...list, ...sortNumbers(extra).map((number) => ({ number, name: '' }))].map((p) => ({
      number: p.number,
      name: p.name || '',
      starter: starters.has(p.number),
      played: starters.has(p.number) || subbedIn[team].has(p.number) || active[team].has(p.number),
      fouls: fouls.get(p.number) || [],
    }));
    const timeouts = { h1: [], h2: [], ot: [] };
    const teamFouls = [0, 0, 0, 0];
    const running = {};
    const quarterEnd = {};
    let score = 0;
    for (const e of sorted) {
      if (e.team !== team) continue;
      if (e.type === 'timeout') {
        const m = playingMinute(e.clock, lenOf(e.quarter));
        (e.quarter <= 2 ? timeouts.h1 : e.quarter <= REGULAR_QUARTERS ? timeouts.h2 : timeouts.ot).push(m);
      } else if (e.type === 'foul') {
        teamFouls[Math.min(e.quarter, REGULAR_QUARTERS) - 1] += 1;
      }
      const p = pointsScored(e);
      if (!p) continue;
      score += p;
      const kind = e.type === 'adjust' ? 'adjust' : e.type === 'ft' ? 'ft' : p === 3 ? 'fg3' : 'fg2';
      running[score] = { kind, player: e.player ?? null, quarter: e.quarter };
    }
    // クォーターの終わりの得点
    const byQ = scoreByQuarter(events)[team];
    let acc = 0;
    for (let q = 1; q <= n; q++) {
      acc += byQ[q - 1] || 0;
      quarterEnd[q] = acc;
    }
    return { players, timeouts, teamFouls, running, quarterEnd };
  };

  const usList = (game.roster || []).map((p) => ({ number: String(p.number), name: p.name || '' }));
  const oppSet = new Set((game.oppNumbers || []).map(String));
  for (const e of sorted) {
    if (e.team !== 'opp') continue;
    if (e.player != null && e.type !== 'lineup') oppSet.add(String(e.player));
    if (e.type === 'sub' && e.out != null) oppSet.add(String(e.out));
    if (e.type === 'lineup') for (const x of e.players || []) oppSet.add(String(x));
  }
  const oppList = sortNumbers([...oppSet]).map((number) => ({ number, name: '' }));
  const byQuarter = scoreByQuarter(events);
  const final = scoreOf(events);
  return {
    teams: { us: make('us', usList), opp: make('opp', oppList) },
    quarters: byQuarter.quarters,
    byQuarter,
    final,
    winner: final.us > final.opp ? 'us' : final.opp > final.us ? 'opp' : null,
  };
}
