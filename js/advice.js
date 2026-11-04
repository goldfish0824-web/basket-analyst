// AIに「対処の例」を聞く（SPEC 第7章フェーズ5「AI質問」の先取り）。すべて純粋関数。
// 決めるのはコーチ。AI の答えは「選択肢の例」として表示し、「〜すべき」とは書かせない（Worker の指示文で指定）。
import { scoreOf, scoreByQuarter } from './stats.js';
import { defenseSide } from './model.js';
import { toWire } from './insights.js';

export const ADVICE_KIND = 'advice';
export const MAX_QUESTION = 200;
export const MAX_OPTIONS = 3;
export const MAX_RELATED = 3;

/** 直近の守備隊形（記録画面の「相手DF」「自DF」）。なければ null */
export function currentDefenses(events) {
  let opp = null;
  let us = null;
  for (let i = events.length - 1; i >= 0 && (opp == null || us == null); i--) {
    const e = events[i];
    if (!e.defense) continue;
    const side = defenseSide(e.type, e.team);
    if (side === 'opp' && opp == null) opp = e.defense;
    if (side === 'us' && us == null) us = e.defense;
  }
  return { opp, us };
}

/** 質問の文字を整える（前後の空白を取り、長さを切る） */
export function cleanQuestion(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION);
}

/**
 * Worker に送る形。
 * item：AI特筆データの1行（{ line, candidate }）か null。question：自由入力の質問（空でもよい。item か question のどちらかは必要）
 * qa：場面別Q&A の { id, title } の一覧（AI が関係の深いものを選ぶ）
 */
export function buildAdvicePayload({ events, quarter, inProgress = false, item = null, question = '', qa = [] }) {
  const ev = events.filter((e) => e.quarter && e.quarter <= quarter);
  const s = scoreOf(ev);
  const q = scoreByQuarter(ev);
  const def = currentDefenses(ev);
  const payload = {
    kind: ADVICE_KIND,
    quarter,
    isHalftime: quarter === 2 && !inProgress,
    inProgress: !!inProgress,
    score: { us: s.us, opp: s.opp, byQuarter: { us: q.us.slice(0, quarter), opp: q.opp.slice(0, quarter) } },
    defenses: { opp: def.opp, us: def.us },
    question: cleanQuestion(question),
    qa: qa.map((x) => ({ id: x.id, title: x.title })),
  };
  if (item && item.candidate) payload.insight = { line: String(item.line || '').slice(0, 80), candidate: toWire(item.candidate) };
  return payload;
}

/**
 * Worker の応答から使えるものだけを取り出す。
 * options：見出しと説明がそろっているものを最大3つ。related：場面別Q&A にある ID だけ。
 */
export function acceptAdvice(data, qaIds = []) {
  if (!data || !Array.isArray(data.options)) return { options: [], related: [] };
  const options = [];
  for (const o of data.options) {
    if (!o || typeof o.label !== 'string' || typeof o.detail !== 'string') continue;
    const label = o.label.trim().slice(0, 40);
    const detail = o.detail.trim().slice(0, 200);
    if (!label || !detail) continue;
    options.push({ label, detail });
    if (options.length >= MAX_OPTIONS) break;
  }
  const known = new Set(qaIds);
  const related = [];
  for (const id of Array.isArray(data.related) ? data.related : []) {
    if (typeof id === 'string' && known.has(id) && !related.includes(id)) related.push(id);
    if (related.length >= MAX_RELATED) break;
  }
  return { options, related };
}

/**
 * AI を使わずに、特筆データの候補から関係の深い場面別Q&A を選ぶ（電波がなくても出せる）。
 * 戻り値は Q&A の ID の配列（存在しないものは呼び出し側で捨てる）。
 */
export function relatedQaFor(candidate) {
  if (!candidate) return [];
  const s = `${candidate.situation || ''} ${candidate.detail || ''}`;
  switch (candidate.category) {
    case 'turnovers': {
      if (candidate.team !== 'us') return [];
      if (/2-2-1/.test(s)) return ['press-221', 'press-turnovers'];
      if (/1-2-1-1/.test(s)) return ['press-1211', 'press-turnovers'];
      if (/1-2-2/.test(s)) return ['press-122', 'press-turnovers'];
      if (/プレス|オールコート/.test(s)) return ['press-turnovers', 'press-fullman'];
      return ['man-pressure', 'press-turnovers'];
    }
    case 'opp_hot': {
      if (/3P|コーナー/.test(s)) return ['def-ace', 'def-closeout'];
      if (/ゴール下|ポスト/.test(s)) return ['def-ace', 'def-post'];
      if (/ドライブ/.test(s)) return ['def-ace', 'def-help'];
      return ['def-ace'];
    }
    case 'opp_leader':
      return ['def-ace'];
    case 'us_defense_eff': {
      if (/2-3/.test(s)) return ['zone-23', 'zone-cold'];
      if (/3-2/.test(s)) return ['zone-32', 'zone-cold'];
      if (/1-3-1/.test(s)) return ['zone-131', 'zone-cold'];
      if (/マンツー/.test(s)) return ['man-pressure', 'man-help'];
      if (/プレス/.test(s)) return ['press-turnovers'];
      return ['zone-cold'];
    }
    case 'rebounds':
      return (candidate.opp || 0) > (candidate.us || 0) ? ['reb-boxout', 'reb-our-oreb'] : ['reb-our-oreb'];
    case 'foul_trouble':
      return ['game-foultrouble', 'def-fouls'];
    case 'run':
      return candidate.team === 'opp' ? ['game-timeout'] : [];
    default:
      return [];
  }
}

/** AI の選んだ関連と、端末で選んだ関連をまとめる（重複なし・最大3つ・存在するものだけ） */
export function mergeRelated(aiIds, localIds, qaIds) {
  const known = new Set(qaIds);
  const out = [];
  for (const id of [...(aiIds || []), ...(localIds || [])]) {
    if (known.has(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_RELATED) break;
  }
  return out;
}
