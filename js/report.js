// 試合後の「AIふりかえり」（SPEC 第7章フェーズ4「試合後のAIレポート」の先取り）。すべて純粋関数。
// 数字はすべて端末で計算し、AI には背番号と数字だけを送る（選手の名前・相手校名・チェック項目のメモは送らない）。
// AI の答えは「良かった点・課題・練習の例」。決めるのはコーチ（「〜すべき」とは書かせない。Worker の指示文で指定）。
import { scoreOf, scoreByQuarter, teamBox, teamIndicators, byDefense, filterShots, zoneStats } from './stats.js';
import { evaluateTarget, isActiveItem } from './review.js';
import { quarterLabel } from './model.js';

export const REPORT_KIND = 'game_report';
export const MAX_COACH_NOTE = 400;
const MAX_ITEMS = 4;

const ma = (m, a) => [m, a];
const round2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

function lineOf(r) {
  return {
    pts: r.pts, fg: ma(r.fgm, r.fga), tp: ma(r.tpm, r.tpa), ft: ma(r.ftm, r.fta),
    or: r.oreb, dr: r.dreb, ast: r.ast, stl: r.stl, to: r.to, pf: r.pf,
  };
}

function active(r) {
  return r.pts || r.fga || r.fta || r.oreb || r.dreb || r.ast || r.stl || r.blk || r.to || r.pf;
}

/** メモの文字を整える */
export function cleanNote(text) {
  return String(text || '').replace(/[ \t　]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_COACH_NOTE);
}

/**
 * Worker に送る形。game は試合、defenses は守備隊形の表示順、coachNote は「AIに伝えたいこと」。
 */
export function buildReportPayload({ game, events, defenses = [], coachNote = '' }) {
  const s = scoreOf(events);
  const byQ = scoreByQuarter(events);
  const ind = teamIndicators(events);
  // 名前は渡さない（背番号だけの行にする）
  const usBox = teamBox(events, 'us', []);
  const oppBox = teamBox(events, 'opp', []);
  const zoneList = (team) => Object.entries(zoneStats(filterShots(events, { team })))
    .filter(([, v]) => v.att > 0)
    .map(([zone, v]) => ({ zone, made: v.made, att: v.att }));
  const defList = (team) => byDefense(events, team, defenses).map((d) => ({
    defense: d.defense, pts: d.pts, fg: ma(d.fgm, d.fga), tp: ma(d.tpm, d.tpa), ft: ma(d.ftm, d.fta), to: d.to,
  }));
  const tags = {};
  for (const e of events) {
    if (e.type !== 'to' || e.team !== 'us') continue;
    for (const t of e.tags && e.tags.length ? e.tags : ['種類なし']) tags[t] = (tags[t] || 0) + 1;
  }
  const insights = [];
  const byQuarter = new Map();
  for (const r of [...(game.insights || [])].sort((a, b) => b.createdAt - a.createdAt)) {
    if (r.inProgress || byQuarter.has(r.quarter)) continue;
    byQuarter.set(r.quarter, r);
  }
  for (const [q, r] of [...byQuarter.entries()].sort((a, b) => a[0] - b[0])) {
    for (const it of r.items || []) insights.push({ quarter: quarterLabel(q), line: String(it.line || '').slice(0, 80) });
  }
  const checklist = (game.checklist || []).filter(isActiveItem).map((it) => {
    const auto = it.target ? evaluateTarget(it.target, events) : null;
    const out = { label: String(it.label || '').slice(0, 60), mark: it.mark || null };
    if (auto && auto.text) out.auto = auto.text;
    return out;
  });
  return {
    kind: REPORT_KIND,
    score: { us: s.us, opp: s.opp, byQuarter: { us: byQ.us, opp: byQ.opp } },
    us: lineOf(usBox.total),
    opp: lineOf(oppBox.total),
    indicators: {
      us: { ppp: round2(ind.us.ppp), orPct: round2(ind.us.orPct), secondChancePts: ind.us.secondChancePts, fastBreakPts: ind.us.fastBreakPts },
      opp: { ppp: round2(ind.opp.ppp), orPct: round2(ind.opp.orPct), secondChancePts: ind.opp.secondChancePts, fastBreakPts: ind.opp.fastBreakPts },
    },
    players: usBox.rows.filter(active).map((r) => ({ no: `#${r.number}`, ...lineOf(r) })),
    oppScorers: oppBox.rows.filter((r) => r.pts >= 6).sort((a, b) => b.pts - a.pts).slice(0, 5)
      .map((r) => ({ no: `#${r.number}`, pts: r.pts, fg: ma(r.fgm, r.fga), tp: ma(r.tpm, r.tpa) })),
    byDefense: defList('us'),
    oppByDefense: defList('opp'),
    zones: zoneList('us'),
    oppZones: zoneList('opp'),
    turnoverTags: Object.entries(tags).map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n),
    insights,
    checklist,
    coachNote: cleanNote(coachNote),
  };
}

function text(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Worker の応答から使えるものだけを取り出す。良かった点も課題もなければ null */
export function acceptReport(data) {
  if (!data || typeof data !== 'object') return null;
  const pairs = (list) => (Array.isArray(list) ? list : [])
    .map((x) => ({ point: text(x && x.point, 80), evidence: text(x && x.evidence, 80) }))
    .filter((x) => x.point)
    .slice(0, MAX_ITEMS);
  const good = pairs(data.good);
  const issues = pairs(data.issues);
  if (!good.length && !issues.length) return null;
  const practice = (Array.isArray(data.practice) ? data.practice : [])
    .map((x) => {
      const m = Number(x && x.minutes);
      return {
        issue: text(x && x.issue, 40),
        menu: text(x && x.menu, 40),
        detail: text(x && x.detail, 200),
        minutes: Number.isFinite(m) && m > 0 ? Math.min(60, Math.round(m)) : null,
      };
    })
    .filter((x) => x.menu && x.detail)
    .slice(0, MAX_ITEMS);
  const watch = (Array.isArray(data.watch) ? data.watch : []).map((x) => text(x, 60)).filter(Boolean).slice(0, MAX_ITEMS);
  return { summary: text(data.summary, 300), good, issues, practice, watch };
}

/** コピーして ほかのアプリに貼る文章（相手校名と日付は端末の中だけで付ける） */
export function reportText(report, { opponent = '', date = '', score = null } = {}) {
  const lines = [];
  const head = ['【AIふりかえり】', opponent ? `vs ${opponent}` : '', date, score ? `${score.us}-${score.opp}` : ''].filter(Boolean).join(' ');
  lines.push(head);
  if (report.summary) lines.push(`要点：${report.summary}`);
  const block = (title, list) => {
    if (!list.length) return;
    lines.push('', `■${title}`);
    for (const x of list) lines.push(`・${x.point}${x.evidence ? `（${x.evidence}）` : ''}`);
  };
  block('良かった点', report.good);
  block('課題', report.issues);
  if (report.practice.length) {
    lines.push('', '■練習の例');
    for (const p of report.practice) {
      lines.push(`・${p.menu}${p.minutes ? `（${p.minutes}分）` : ''}${p.issue ? `［${p.issue}］` : ''}：${p.detail}`);
    }
  }
  if (report.watch.length) {
    lines.push('', '■次の試合で見る数字');
    for (const w of report.watch) lines.push(`・${w}`);
  }
  lines.push('', '※AIが試合の数字から作った例です。決めるのはコーチです。');
  return lines.join('\n');
}
