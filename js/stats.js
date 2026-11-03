// 集計（SPEC 4章、記録画面の上部バー）。すべて純粋関数。
import { ZONES } from './court.js';
import { REGULAR_QUARTERS, sortNumbers, otherTeam } from './model.js';

/** そのイベントで入った得点 */
export function pointsScored(e) {
  if (e.type === 'adjust') return Number(e.points) || 0;
  if ((e.type === 'fg' || e.type === 'ft') && e.made) return Number(e.points) || 0;
  return 0;
}

export function scoreOf(events) {
  const s = { us: 0, opp: 0 };
  for (const e of events) {
    if (e.team === 'us' || e.team === 'opp') s[e.team] += pointsScored(e);
  }
  return s;
}

export function maxQuarter(events) {
  let q = REGULAR_QUARTERS;
  for (const e of events) if (e.quarter > q) q = e.quarter;
  return q;
}

/** クォーター別得点。us[0] が1Q。 */
export function scoreByQuarter(events) {
  const n = maxQuarter(events);
  const us = new Array(n).fill(0);
  const opp = new Array(n).fill(0);
  for (const e of events) {
    const p = pointsScored(e);
    if (!p || !e.quarter) continue;
    if (e.team === 'us') us[e.quarter - 1] += p;
    else if (e.team === 'opp') opp[e.quarter - 1] += p;
  }
  return { quarters: Array.from({ length: n }, (_, i) => i + 1), us, opp };
}

/**
 * チームファウル数（そのクォーター分）。
 * 延長はすべて4Qの続きとして数える（FIBA規則）。
 */
export function teamFouls(events, quarter) {
  const inScope = quarter > REGULAR_QUARTERS ? (q) => q >= REGULAR_QUARTERS : (q) => q === quarter;
  const f = { us: 0, opp: 0 };
  for (const e of events) {
    if (e.type === 'foul' && inScope(e.quarter) && (e.team === 'us' || e.team === 'opp')) f[e.team] += 1;
  }
  return f;
}

/** 個人ファウル数（試合全体）。{ us: { '7': 2 }, opp: { '12': 1 } } */
export function playerFouls(events) {
  const f = { us: {}, opp: {} };
  for (const e of events) {
    if (e.type !== 'foul' || e.player == null || !f[e.team]) continue;
    f[e.team][e.player] = (f[e.team][e.player] || 0) + 1;
  }
  return f;
}

export function emptyLine() {
  return { pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, to: 0, pf: 0 };
}

function addToLine(line, e) {
  line.pts += pointsScored(e);
  switch (e.type) {
    case 'fg':
      line.fga += 1;
      if (e.made) line.fgm += 1;
      if (e.points === 3) {
        line.tpa += 1;
        if (e.made) line.tpm += 1;
      }
      break;
    case 'ft':
      line.fta += 1;
      if (e.made) line.ftm += 1;
      break;
    case 'oreb': line.oreb += 1; break;
    case 'dreb': line.dreb += 1; break;
    case 'ast': line.ast += 1; break;
    case 'stl': line.stl += 1; break;
    case 'blk': line.blk += 1; break;
    case 'to': line.to += 1; break;
    case 'foul': line.pf += 1; break;
    default: break;
  }
}

/**
 * ボックススコア。
 * players = [{ number, name }]（表示順）。イベントに出てきたがリストにない背番号は後ろに足す。
 * 選手不明（チームリバウンド、得点補正など）は other にまとめる。total は全体。
 */
export function teamBox(events, team, players = []) {
  const rows = new Map();
  for (const p of players) rows.set(String(p.number), { number: String(p.number), name: p.name || '', ...emptyLine() });
  const extra = [];
  const other = emptyLine();
  let otherUsed = false;
  const total = emptyLine();
  for (const e of events) {
    if (e.team !== team) continue;
    if (e.type === 'timeout' || e.type === 'q_start' || e.type === 'q_end') continue;
    addToLine(total, e);
    if (e.player == null) {
      addToLine(other, e);
      otherUsed = true;
      continue;
    }
    if (!rows.has(e.player)) {
      rows.set(e.player, { number: e.player, name: '', ...emptyLine() });
      extra.push(e.player);
    }
    addToLine(rows.get(e.player), e);
  }
  const listed = players.map((p) => rows.get(String(p.number)));
  const added = sortNumbers(extra).map((n) => rows.get(n));
  return { rows: [...listed, ...added], other: otherUsed ? other : null, total };
}

/** チーム指標（SPEC 4章） */
export function teamIndicators(events) {
  const t = { us: teamBox(events, 'us').total, opp: teamBox(events, 'opp').total };
  const out = {};
  for (const team of ['us', 'opp']) {
    const me = t[team];
    const them = t[otherTeam(team)];
    const poss = me.fga + 0.44 * me.fta - me.oreb + me.to;
    const orDen = me.oreb + them.dreb;
    out[team] = {
      pts: me.pts,
      poss,
      ppp: poss > 0 ? me.pts / poss : null,
      orPct: orDen > 0 ? me.oreb / orDen : null,
      secondChancePts: taggedPoints(events, team, 'セカンドチャンス'),
      fastBreakPts: taggedPoints(events, team, '速攻'),
    };
  }
  return out;
}

/** その種類タグが付いたFG成功の得点合計 */
export function taggedPoints(events, team, tag) {
  let p = 0;
  for (const e of events) {
    if (e.team === team && e.type === 'fg' && e.made && e.tags && e.tags.includes(tag)) p += Number(e.points) || 0;
  }
  return p;
}

/**
 * 守備隊形別（offenseTeam の攻撃を、守っている側の隊形ごとに）。
 * order：表示順（設定の選択肢）。隊形なしは「未設定」。
 */
export function byDefense(events, offenseTeam, order = []) {
  const map = new Map();
  const get = (d) => {
    const key = d || '未設定';
    if (!map.has(key)) map.set(key, { defense: key, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, to: 0, pts: 0 });
    return map.get(key);
  };
  for (const e of events) {
    if (e.team !== offenseTeam) continue;
    if (e.type !== 'fg' && e.type !== 'ft' && e.type !== 'to') continue;
    const r = get(e.defense);
    if (e.type === 'fg') {
      r.fga += 1;
      if (e.made) r.fgm += 1;
      if (e.points === 3) {
        r.tpa += 1;
        if (e.made) r.tpm += 1;
      }
    } else if (e.type === 'ft') {
      r.fta += 1;
      if (e.made) r.ftm += 1;
    } else {
      r.to += 1;
    }
    r.pts += pointsScored(e);
  }
  const rank = (d) => {
    const i = order.indexOf(d);
    if (i >= 0) return i;
    return d === '未設定' ? order.length + 1 : order.length;
  };
  return [...map.values()].sort((a, b) => rank(a.defense) - rank(b.defense) || a.defense.localeCompare(b.defense));
}

// ---- シュートチャート ----

/** クォーターの絞り込み：'all' | 1..n | 'H1'（前半）| 'H2'（後半）| 'OT'（延長） */
export function inQuarterRange(q, range) {
  if (range == null || range === 'all') return true;
  if (range === 'H1') return q === 1 || q === 2;
  if (range === 'H2') return q === 3 || q === 4;
  if (range === 'OT') return q > REGULAR_QUARTERS;
  return q === Number(range);
}

/**
 * シュート（FG）の絞り込み。
 * filter = { team, player, quarter, defense, tag }
 *   player：'all' | 背番号 | 'none'（番号なし）
 *   defense：'all' | 隊形 | '未設定'
 *   tag：'all' | タグ | 'none'（タグなし）
 */
export function filterShots(events, filter = {}) {
  const { team = 'us', player = 'all', quarter = 'all', defense = 'all', tag = 'all' } = filter;
  return events.filter((e) => {
    if (e.type !== 'fg') return false;
    if (team !== 'all' && e.team !== team) return false;
    if (player === 'none' && e.player != null) return false;
    if (player !== 'all' && player !== 'none' && e.player !== String(player)) return false;
    if (!inQuarterRange(e.quarter, quarter)) return false;
    if (defense !== 'all' && (e.defense || '未設定') !== defense) return false;
    if (tag === 'none' && e.tags && e.tags.length) return false;
    if (tag !== 'all' && tag !== 'none' && !(e.tags || []).includes(tag)) return false;
    return true;
  });
}

/** ゾーンごとの成功・試投 */
export function zoneStats(shots) {
  const z = {};
  for (const name of ZONES) z[name] = { made: 0, att: 0 };
  for (const s of shots) {
    if (!z[s.zone]) continue;
    z[s.zone].att += 1;
    if (s.made) z[s.zone].made += 1;
  }
  return z;
}

export function shotTotals(shots) {
  const t = { fgm: 0, fga: 0, tpm: 0, tpa: 0, pts: 0 };
  for (const s of shots) {
    t.fga += 1;
    if (s.made) {
      t.fgm += 1;
      t.pts += Number(s.points) || 0;
    }
    if (s.points === 3) {
      t.tpa += 1;
      if (s.made) t.tpm += 1;
    }
  }
  return t;
}

// ---- 表示の書式 ----

export function pctText(made, att) {
  if (!att) return '—';
  return `${Math.round((made / att) * 100)}%`;
}

/** 「3-8（38%）」 */
export function maText(made, att) {
  return att ? `${made}-${att}（${pctText(made, att)}）` : '0-0';
}

export function decimalText(v, digits = 1) {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}
