// AI特筆データの「候補」（SPEC 5-3）と端末内の順位付け（SPEC 5-4）。すべて純粋関数。
// 数字はすべてここで計算する。AI には候補から選んで1行に整えることだけを頼む。
import { ZONE_LABELS, THREE_ZONES } from './court.js';
import { quarterLabel, whoLabel, REGULAR_QUARTERS } from './model.js';
import { pointsScored, scoreOf, scoreByQuarter } from './stats.js';

export const MAX_AI_CANDIDATES = 20;
export const MAX_INSIGHTS = 3;

export const CATEGORY_LABEL = {
  opp_hot: '相手の得点源の偏り',
  opp_leader: '相手の得点リーダー',
  us_defense_eff: '自チームの攻めの効率（守備隊形別）',
  us_zone: '自チームのゾーン別効率',
  turnovers: 'ターンオーバーの集中',
  rebounds: 'リバウンド差',
  foul_trouble: 'ファウルトラブル',
  opp_foul_trouble: '相手のファウルトラブル',
  free_throws: 'フリースロー',
  run: '流れ',
};

const SHOT_TAG_SIDES = ['ドライブ', 'ポスト', 'ジャンプシュート'];

function range(a, b) {
  const out = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

function pct(made, att) {
  return att ? `${Math.round((made / att) * 100)}%` : '—';
}

/**
 * 候補を作る範囲（そのクォーター／前半・後半／累計）。
 * 同じクォーターの組み合わせになる範囲は1つにまとめる（1Q終了時の「累計」＝「1Q」など）。
 */
export function scopesFor(quarter) {
  const list = [{ key: `q${quarter}`, label: quarterLabel(quarter), quarters: [quarter], single: true }];
  if (quarter === 2) list.push({ key: 'H1', label: '前半', quarters: [1, 2] });
  if (quarter === REGULAR_QUARTERS) list.push({ key: 'H2', label: '後半', quarters: [3, 4] });
  list.push({ key: 'all', label: '累計', quarters: range(1, quarter) });
  const seen = new Set();
  return list.filter((s) => {
    const k = s.quarters.join(',');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** ゾーンの呼び方（3Pゾーンは「右45度3P」のように） */
export function zoneSituation(zone) {
  const label = ZONE_LABELS[zone] || zone;
  return THREE_ZONES.includes(zone) ? `${label}3P` : label;
}

/** ゴールから見た左右（オフェンス視点）。中央付近は「正面」 */
export function sideOf(x) {
  if (x < 6.5) return '左';
  if (x > 8.5) return '右';
  return '正面';
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const it of list) {
    const k = keyFn(it);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

function madeCount(shots) {
  return shots.filter((s) => s.made).length;
}

// ---- カテゴリごとの候補 ----

/** 相手の得点源の偏り：同じ選手×（ゾーン／種類タグ／左右＋種類タグ）で試投3以上・成功率50%以上 */
function oppHot(ev, scope) {
  const shots = ev.filter((e) => e.type === 'fg' && e.team === 'opp' && e.player != null);
  const groups = [];
  for (const [player, ps] of groupBy(shots, (e) => e.player)) {
    for (const [zone, zs] of groupBy(ps, (e) => e.zone)) groups.push({ player, situation: zoneSituation(zone), shots: zs, prio: 2 });
    for (const tag of new Set(ps.flatMap((e) => e.tags || []))) {
      const ts = ps.filter((e) => (e.tags || []).includes(tag));
      groups.push({ player, situation: tag, shots: ts, prio: 1 });
      if (SHOT_TAG_SIDES.includes(tag)) {
        for (const [side, ss] of groupBy(ts, (e) => sideOf(e.x))) groups.push({ player, situation: `${side}${tag}`, shots: ss, prio: 3 });
      }
    }
  }
  // 同じシュートの集まりは、いちばん具体的な言い方（左右＋タグ ＞ ゾーン ＞ タグ）だけ残す
  const best = new Map();
  for (const g of groups) {
    const att = g.shots.length;
    const made = madeCount(g.shots);
    if (att < 3 || made / att < 0.5) continue;
    const k = `${g.player}|${g.shots.map((s) => s.id).sort().join(',')}`;
    const cur = best.get(k);
    if (!cur || g.prio > cur.prio) best.set(k, { ...g, att, made });
  }
  return [...best.values()].map((g) => ({
    category: 'opp_hot', team: 'opp', player: g.player, subject: whoLabel('opp', g.player),
    situation: g.situation, made: g.made, att: g.att, scope: scope.label,
  }));
}

/** 相手の得点リーダー：相手チーム得点の30%以上（6点以上） */
function oppLeader(ev, scope) {
  const total = ev.filter((e) => e.team === 'opp').reduce((s, e) => s + pointsScored(e), 0);
  if (!total) return [];
  const out = [];
  for (const [player, ps] of groupBy(ev.filter((e) => e.team === 'opp' && e.player != null), (e) => e.player)) {
    const value = ps.reduce((s, e) => s + pointsScored(e), 0);
    if (value >= 6 && value / total >= 0.3) {
      out.push({ category: 'opp_leader', team: 'opp', player, subject: whoLabel('opp', player), situation: '得点', value, total, scope: scope.label });
    }
  }
  return out;
}

/** 自チームの攻めの効率（守備隊形別）：試投5以上で25%以下または60%以上（FG全体と3P） */
function usDefenseEff(ev, scope) {
  const shots = ev.filter((e) => e.type === 'fg' && e.team === 'us' && e.defense);
  const out = [];
  for (const [defense, ds] of groupBy(shots, (e) => e.defense)) {
    const sets = [
      { kind: 'FG', list: ds },
      { kind: '3P', list: ds.filter((e) => e.points === 3) },
    ];
    for (const { kind, list } of sets) {
      const att = list.length;
      const made = madeCount(list);
      if (att < 5) continue;
      const r = made / att;
      if (r > 0.25 && r < 0.6) continue;
      out.push({ category: 'us_defense_eff', team: 'us', subject: '自チーム', situation: `対${defense}の${kind}`, made, att, scope: scope.label });
    }
  }
  return out;
}

/** 自チームのゾーン別効率：試投4以上 */
function usZone(ev, scope) {
  const shots = ev.filter((e) => e.type === 'fg' && e.team === 'us');
  const out = [];
  for (const [zone, zs] of groupBy(shots, (e) => e.zone)) {
    if (zs.length < 4) continue;
    out.push({ category: 'us_zone', team: 'us', subject: '自チーム', situation: zoneSituation(zone), made: madeCount(zs), att: zs.length, scope: scope.label });
  }
  return out;
}

/** ターンオーバーの集中：クォーター4以上、または隊形・種類への偏り（4本以上のうち3本以上かつ6割以上） */
function turnovers(ev, scope) {
  const out = [];
  for (const team of ['us', 'opp']) {
    const tos = ev.filter((e) => e.type === 'to' && e.team === team);
    const n = tos.length;
    const subject = team === 'us' ? '自チーム' : '相手';
    if (scope.single && n >= 4) {
      out.push({ category: 'turnovers', team, subject, situation: 'ターンオーバー', value: n, scope: scope.label });
    }
    if (n < 4) continue;
    for (const [defense, ds] of groupBy(tos, (e) => e.defense)) {
      const k = ds.length;
      if (k >= 3 && k / n >= 0.6) {
        const detail = team === 'us' ? `${defense}から` : `自チームの${defense}から`;
        out.push({ category: 'turnovers', team, subject, situation: `ターンオーバー（${detail}）`, detail, by: 'defense', made: k, att: n, scope: scope.label });
      }
    }
    for (const tag of new Set(tos.flatMap((e) => e.tags || []))) {
      const k = tos.filter((e) => (e.tags || []).includes(tag)).length;
      if (k >= 3 && k / n >= 0.6) {
        out.push({ category: 'turnovers', team, subject, situation: `ターンオーバー（${tag}）`, detail: tag, by: 'tag', made: k, att: n, scope: scope.label });
      }
    }
  }
  return out;
}

/** リバウンド差：ORの差が4以上 */
function rebounds(ev, scope) {
  const us = ev.filter((e) => e.type === 'oreb' && e.team === 'us').length;
  const opp = ev.filter((e) => e.type === 'oreb' && e.team === 'opp').length;
  if (Math.abs(us - opp) < 4) return [];
  return [{ category: 'rebounds', team: us > opp ? 'us' : 'opp', subject: 'リバウンド', situation: 'OR', us, opp, scope: scope.label }];
}

/** フリースロー：試投6以上で50%以下 */
function freeThrows(ev, scope) {
  const out = [];
  for (const team of ['us', 'opp']) {
    const fts = ev.filter((e) => e.type === 'ft' && e.team === team);
    const att = fts.length;
    const made = madeCount(fts);
    if (att >= 6 && made / att <= 0.5) {
      out.push({ category: 'free_throws', team, subject: team === 'us' ? '自チーム' : '相手', situation: 'FT', made, att, scope: scope.label });
    }
  }
  return out;
}

/** 流れ：クォーターの得点差8以上 */
function run(ev, scope) {
  const s = scoreOf(ev);
  if (Math.abs(s.us - s.opp) < 8) return [];
  return [{ category: 'run', team: s.us > s.opp ? 'us' : 'opp', subject: 'クォーター得点', situation: '得点差', us: s.us, opp: s.opp, scope: scope.label }];
}

/**
 * ファウルトラブル（試合全体の個人ファウル）。
 * 前半は2以上、3Q終了時は3以上、4以上はいつでも。
 */
export function isFoulTrouble(fouls, quarter) {
  if (fouls >= 4) return true;
  if (quarter <= 2) return fouls >= 2;
  if (quarter === 3) return fouls >= 3;
  return false;
}

function foulTrouble(events, quarter, inProgress) {
  const scope = `${quarterLabel(quarter)}${inProgress ? '途中' : '終了時'}`;
  const out = [];
  for (const team of ['us', 'opp']) {
    const counts = new Map();
    for (const e of events) {
      if (e.type === 'foul' && e.team === team && e.player != null) counts.set(e.player, (counts.get(e.player) || 0) + 1);
    }
    for (const [player, value] of counts) {
      if (!isFoulTrouble(value, quarter)) continue;
      out.push({
        category: team === 'us' ? 'foul_trouble' : 'opp_foul_trouble', team, player,
        // FIBA：個人ファウル5つで退場
        subject: whoLabel(team, player), situation: value >= 5 ? '5ファウルで退場' : 'ファウル', value, scope,
      });
    }
  }
  return out;
}

// ---- 順位付け（SPEC 5-4） ----

const OTHER_WEIGHT = {
  foul_trouble: 0.2,
  opp_foul_trouble: 0.18,
  opp_hot: 0.17,
  us_defense_eff: 0.16,
  run: 0.15,
  opp_leader: 0.14,
  free_throws: 0.12,
  us_zone: 0.1,
  turnovers: 0.1,
  rebounds: 0.1,
};

/** 大きさ（0〜1）。試投数・差・割合が大きいほど上 */
function magnitude(c) {
  switch (c.category) {
    case 'run':
      return Math.min(Math.abs(c.us - c.opp), 20) / 20;
    case 'rebounds':
      return Math.min(Math.abs(c.us - c.opp), 12) / 12;
    case 'opp_leader':
      return Math.min(c.value / c.total, 1);
    case 'foul_trouble':
    case 'opp_foul_trouble':
      return Math.min(c.value, 5) / 5;
    case 'turnovers':
      return Math.min(c.att || c.value || 0, 12) / 12;
    default:
      return Math.min(c.att || 0, 20) / 20;
  }
}

function isUsSlump(c) {
  return c.team === 'us' && ['us_defense_eff', 'us_zone', 'free_throws'].includes(c.category) && c.att >= 5 && c.made / c.att <= 0.2;
}

/**
 * 端末内の点数（0〜1）。
 * ファウル4以上 ＞ 相手の得点源の偏り（試投4以上・70%以上）＞ 自チームの極端な不振（試投5以上・20%以下）
 * ＞ ターンオーバーの集中 ＞ リバウンド差 ＞ その他。同じ段では試投数（大きさ）が多いほど上。
 */
export function localScore(c) {
  const mag = magnitude(c);
  const isFoul = c.category === 'foul_trouble' || c.category === 'opp_foul_trouble';
  if (isFoul && c.value >= 4) return 0.9 + 0.06 * mag + (c.category === 'foul_trouble' ? 0.01 : 0);
  if (c.category === 'opp_hot' && c.att >= 4 && c.made / c.att >= 0.7) return 0.8 + 0.08 * mag + 0.01 * (c.made / c.att);
  if (isUsSlump(c)) return 0.7 + 0.08 * mag + 0.01 * (1 - c.made / c.att);
  if (c.category === 'turnovers') return 0.6 + 0.08 * mag;
  if (c.category === 'rebounds') return 0.5 + 0.08 * mag;
  return Math.min(0.45, 0.1 + (OTHER_WEIGHT[c.category] || 0.05) + 0.1 * mag);
}

// ---- AI に伝えない項目（記録し忘れが多い項目を、特筆データ・対処の例・ふりかえりで扱わない） ----

export const AI_EXCLUDE_ITEMS = [
  { key: 'rebounds', label: 'リバウンド' },
  { key: 'usDefense', label: '自チームの守備隊形' },
  { key: 'oppDefense', label: '相手の守備隊形' },
];

/** 選んでいる項目の名前（「リバウンド・相手の守備隊形」） */
export function excludedLabels(exclude) {
  return AI_EXCLUDE_ITEMS.filter((x) => exclude && exclude[x.key]).map((x) => x.label);
}

/** 守備隊形による偏りのターンオーバーか（古い記録には by がないので、「〜から」で見分ける） */
function isDefenseTurnover(c) {
  return c.category === 'turnovers' && (c.by === 'defense' || (c.by == null && /から$/.test(c.detail || '')));
}

/**
 * 候補が「伝えない項目」に当たるか。
 * リバウンド：リバウンド差。相手の守備隊形：自チームの攻めの守備隊形別・自チームのターンオーバーの隊形の偏り。
 * 自チームの守備隊形：相手のターンオーバーの隊形の偏り。
 */
export function isExcluded(c, exclude) {
  if (!c || !exclude) return false;
  if (exclude.rebounds && c.category === 'rebounds') return true;
  if (exclude.oppDefense && (c.category === 'us_defense_eff' || (isDefenseTurnover(c) && c.team === 'us'))) return true;
  if (exclude.usDefense && isDefenseTurnover(c) && c.team === 'opp') return true;
  return false;
}

/** 点数の高い順（同点なら試投数の多い順）。元の配列は変えない */
export function rankCandidates(list) {
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.localScore - a.c.localScore || (b.c.att || 0) - (a.c.att || 0) || a.i - b.i)
    .map((x) => x.c);
}

/**
 * 候補をすべて作り、順位を付けて c1, c2… の ID を振る。
 * opts = { quarter, inProgress }（inProgress：タイムアウトなどクォーターの途中）
 */
export function buildCandidates(allEvents, { quarter, inProgress = false, exclude = null }) {
  const events = allEvents.filter((e) => e.quarter && e.quarter <= quarter);
  const raw = [];
  for (const scope of scopesFor(quarter)) {
    const ev = events.filter((e) => scope.quarters.includes(e.quarter));
    raw.push(...oppHot(ev, scope), ...oppLeader(ev, scope), ...usDefenseEff(ev, scope), ...usZone(ev, scope),
      ...turnovers(ev, scope), ...rebounds(ev, scope), ...freeThrows(ev, scope));
    if (scope.single) raw.push(...run(ev, scope));
  }
  raw.push(...foulTrouble(events, quarter, inProgress));
  // 「AIに伝えない」と決めた項目（記録が不完全なもの）は候補にしない
  for (let i = raw.length - 1; i >= 0; i--) if (isExcluded(raw[i], exclude)) raw.splice(i, 1);

  // 範囲が違っても数字がまったく同じなら、狭い範囲（先に作ったほう）だけ残す
  const seen = new Set();
  const unique = raw.filter((c) => {
    const sig = JSON.stringify([c.category, c.subject, c.situation, c.made, c.att, c.value, c.total, c.us, c.opp]);
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  for (const c of unique) c.localScore = Math.round(localScore(c) * 100) / 100;
  return rankCandidates(unique).map((c, i) => ({ id: `c${i + 1}`, ...c }));
}

/** 端末内の上位（同じカテゴリ×主語は1つだけ） */
export function pickLocal(candidates, n = MAX_INSIGHTS) {
  const used = new Set();
  const out = [];
  for (const c of rankCandidates(candidates)) {
    const k = `${c.category}|${c.subject}`;
    if (used.has(k)) continue;
    used.add(k);
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

// ---- AI に送る形（SPEC 5-5） ----

const WIRE_FIELDS = ['id', 'category', 'subject', 'situation', 'made', 'att', 'value', 'total', 'us', 'opp', 'scope', 'localScore'];

/** AI に送る候補。選手名は持っていない（背番号だけ） */
export function toWire(c) {
  const out = {};
  for (const k of WIRE_FIELDS) if (c[k] !== undefined && c[k] !== null) out[k] = c[k];
  return out;
}

export function buildPayload({ events, quarter, inProgress = false, candidates }) {
  const ev = events.filter((e) => e.quarter && e.quarter <= quarter);
  const s = scoreOf(ev);
  const q = scoreByQuarter(ev);
  const payload = {
    kind: 'quarter_insight',
    quarterEnded: quarter,
    isHalftime: quarter === 2 && !inProgress,
    score: { us: s.us, opp: s.opp, byQuarter: { us: q.us.slice(0, quarter), opp: q.opp.slice(0, quarter) } },
    candidates: rankCandidates(candidates).slice(0, MAX_AI_CANDIDATES).map(toWire),
  };
  if (inProgress) payload.inProgress = true;
  return payload;
}

/**
 * AI の応答から使える行だけを取り出す（SPEC 5-5）。
 * 候補にない candidateId は捨てる。同じ候補は1回だけ。最大3行。根拠は候補の数字を使う。
 */
export function acceptAiResponse(data, sentCandidates) {
  if (!data || !Array.isArray(data.insights)) return [];
  const byId = new Map(sentCandidates.map((c) => [c.id, c]));
  const used = new Set();
  const out = [];
  for (const it of data.insights) {
    if (!it || typeof it.candidateId !== 'string' || typeof it.line !== 'string') continue;
    const c = byId.get(it.candidateId);
    const line = it.line.trim().slice(0, 80);
    if (!c || used.has(c.id) || !line) continue;
    used.add(c.id);
    out.push({ candidateId: c.id, line, candidate: c });
    if (out.length >= MAX_INSIGHTS) break;
  }
  return out;
}

// ---- 表示の文言（事実だけ。「〜すべき」は書かない） ----

/** AI を使わないときの1行 */
export function localLine(c) {
  switch (c.category) {
    case 'opp_hot':
      return `${c.subject}、${c.situation}で${c.att}本中${c.made}本成功`;
    case 'opp_leader':
      return `${c.subject}、${c.scope}${c.value}点（相手の${pct(c.value, c.total)}）`;
    case 'us_defense_eff':
      return `自チーム、${c.situation}は${c.att}本中${c.made}本`;
    case 'us_zone':
      return `自チーム、${c.situation}は${c.att}本中${c.made}本成功`;
    case 'turnovers':
      return c.att
        ? `${c.subject}、${c.scope}のターンオーバー${c.att}本中${c.made}本が${c.detail}`
        : `${c.subject}、${c.scope}のターンオーバー${c.value}本`;
    case 'rebounds':
      return `${c.scope}のOR、自チーム${c.us}・相手${c.opp}`;
    case 'foul_trouble':
    case 'opp_foul_trouble':
      return c.value >= 5 ? `${c.subject}、5ファウルで退場（${c.scope}）` : `${c.subject}、ファウル${c.value}（${c.scope}）`;
    case 'free_throws':
      return `${c.subject}、${c.scope}のFTは${c.att}本中${c.made}本`;
    case 'run':
      return `${c.scope}、自チーム${c.us}・相手${c.opp}`;
    default:
      return `${c.subject} ${c.situation}`;
  }
}

/** 各行の下に出す根拠（数字と対象範囲）。names = { 背番号: 呼び名 }（自チームだけ、端末内で対応付け） */
export function evidenceText(c, names = {}) {
  let main;
  switch (c.category) {
    case 'turnovers':
      main = c.att ? `ターンオーバー ${c.att}本中${c.made}本（${pct(c.made, c.att)}）` : `ターンオーバー ${c.value}本`;
      break;
    case 'opp_leader':
      main = `${c.value}点／相手の計${c.total}点（${pct(c.value, c.total)}）`;
      break;
    case 'rebounds':
      main = `OR 自チーム${c.us}・相手${c.opp}`;
      break;
    case 'foul_trouble':
    case 'opp_foul_trouble':
      main = c.value >= 5 ? `個人ファウル ${c.value}（退場）` : `個人ファウル ${c.value}`;
      break;
    case 'run':
      main = `得点 自チーム${c.us}・相手${c.opp}`;
      break;
    default:
      main = `${c.made}-${c.att}（${pct(c.made, c.att)}）`;
  }
  const name = c.team === 'us' && c.player != null && names[c.player] ? `　#${c.player} ${names[c.player]}` : '';
  return `${main}　${c.scope}${name}`;
}
