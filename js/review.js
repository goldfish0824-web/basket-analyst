// 振り返り（SPEC 6章）：動画との連動、プレー一覧の絞り込み、チェックポイントの自動判定。すべて純粋関数。
import { quarterLabel, REGULAR_QUARTERS } from './model.js';
import { inQuarterRange, teamBox, teamIndicators, taggedPoints } from './stats.js';

export const DEFAULT_REWIND_SEC = 8;

// ---- YouTube ----

const ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

/**
 * YouTube の URL から動画 ID を取り出す。
 * 対応：youtube.com/watch?v=ID、youtu.be/ID、youtube.com/live/ID（www. / m. / 余分な引数つきも可）
 */
export function parseYouTubeId(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] || null;
  else if (host === 'youtube.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/live\/([^/]+)/);
      if (m) id = m[1];
    }
  }
  return id && ID_RE.test(id) ? id : null;
}

/** 指定した秒から再生する URL（?t=秒） */
export function youtubeUrlAt(id, sec) {
  return `https://youtu.be/${id}?t=${Math.max(0, Math.floor(sec))}`;
}

/** 「12:34」「1:02:03」「754」→ 秒。読めなければ null */
export function parseClock(text) {
  const s = String(text ?? '')
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ':');
  if (s === '') return null;
  if (!/^\d+(:\d{1,2}){0,2}$/.test(s)) return null;
  const parts = s.split(':').map(Number);
  if (parts.length > 1 && parts.slice(1).some((p) => p >= 60)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** 秒 → 「12:34」「1:02:03」 */
export function formatClock(sec) {
  const t = Math.max(0, Math.floor(sec));
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}

/** そのクォーターの q_start の時刻（やり直しがあれば最後のもの） */
export function quarterStartTs(events, quarter) {
  let best = null;
  for (const e of events) {
    if (e.type === 'q_start' && e.quarter === quarter && (!best || e.seq > best.seq)) best = e;
  }
  return best ? best.ts : null;
}

/** イベントに対応する動画（そのクォーターの動画があればそれ、なければ試合全体の動画） */
export function videoFor(event, videos = []) {
  const valid = videos.filter((v) => v && parseYouTubeId(v.url));
  return (
    valid.find((v) => v.quarter != null && Number(v.quarter) === event.quarter) ||
    valid.find((v) => v.quarter == null) ||
    null
  );
}

/**
 * 動画の中の秒数（SPEC 6-1）
 * ＝（イベントの ts − 対応する q_start の ts）÷ 1000 ＋ 入力した秒数 − 巻き戻し秒数
 * 試合全体の動画は 1Q の q_start（試合開始）を、クォーターごとの動画はそのクォーターの q_start を基準にする。
 */
export function videoSeconds(event, events, video, rewindSec = DEFAULT_REWIND_SEC) {
  if (!video || event.ts == null) return null;
  const baseQuarter = video.quarter == null ? 1 : Number(video.quarter);
  const base = quarterStartTs(events, baseQuarter);
  if (base == null) return null;
  const sec = (event.ts - base) / 1000 + (Number(video.offsetSec) || 0) - (Number(rewindSec) || 0);
  return Math.max(0, Math.floor(sec));
}

/** プレー一覧の「動画」ボタン用 { url, sec, video } */
export function videoLink(event, events, videos, rewindSec) {
  const video = videoFor(event, videos);
  if (!video) return null;
  const sec = videoSeconds(event, events, video, rewindSec);
  if (sec == null) return null;
  return { url: youtubeUrlAt(parseYouTubeId(video.url), sec), sec, video };
}

/** 動画の対象の表示 */
export function videoScopeLabel(quarter) {
  return quarter == null ? '試合全体' : quarterLabel(Number(quarter));
}

// ---- プレー一覧 ----

export const PLAY_KINDS = [
  { key: 'all', label: 'すべて' },
  { key: 'shot', label: 'シュート' },
  { key: 'shot_made', label: 'シュート成功' },
  { key: 'shot_miss', label: 'シュート失敗' },
  { key: 'ft', label: 'フリースロー' },
  { key: 'reb', label: 'リバウンド' },
  { key: 'to', label: 'ターンオーバー' },
  { key: 'foul', label: 'ファウル' },
  { key: 'ast_stl_blk', label: 'アシスト・スティール・ブロック' },
  { key: 'timeout', label: 'タイムアウト' },
  { key: 'quarter', label: 'クォーター開始・終了' },
];

function kindMatch(e, kind) {
  switch (kind) {
    case 'all': return true;
    case 'shot': return e.type === 'fg';
    case 'shot_made': return e.type === 'fg' && e.made;
    case 'shot_miss': return e.type === 'fg' && !e.made;
    case 'ft': return e.type === 'ft';
    case 'reb': return e.type === 'oreb' || e.type === 'dreb';
    case 'to': return e.type === 'to';
    case 'foul': return e.type === 'foul';
    case 'ast_stl_blk': return e.type === 'ast' || e.type === 'stl' || e.type === 'blk';
    case 'timeout': return e.type === 'timeout';
    case 'quarter': return e.type === 'q_start' || e.type === 'q_end';
    default: return true;
  }
}

/**
 * filter = { team: 'all'|'us'|'opp', player: 'all'|背番号|'none', kind, quarter: 'all'|n|'H1'|'H2'|'OT', defense: 'all'|隊形|'未設定' }
 * 試合の流れの順（seq 順）で返す。
 */
export function filterPlays(events, filter = {}) {
  const { team = 'all', player = 'all', kind = 'all', quarter = 'all', defense = 'all' } = filter;
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .filter((e) => {
      if (!kindMatch(e, kind)) return false;
      if (team !== 'all' && e.team !== team) return false;
      if (player === 'none' && e.player != null) return false;
      if (player !== 'all' && player !== 'none' && e.player !== String(player)) return false;
      if (!inQuarterRange(e.quarter, quarter)) return false;
      if (defense !== 'all' && (e.defense || '未設定') !== defense) return false;
      return true;
    });
}

/** クォーター開始からの経過（「+3:12」） */
export function elapsedText(event, events) {
  const base = quarterStartTs(events, event.quarter);
  if (base == null || event.ts == null) return '';
  return `+${formatClock((event.ts - base) / 1000)}`;
}

// ---- チェックポイント（SPEC 6-2） ----

function pct(m, a) {
  return a ? (m / a) * 100 : null;
}

/** 数字と結びつけられる項目 */
export const CHECK_METRICS = [
  { key: 'us_pts', label: '自チームの得点', unit: '点', calc: (t) => t.us.pts },
  { key: 'opp_pts', label: '相手の得点（失点）', unit: '点', calc: (t) => t.opp.pts },
  { key: 'us_to', label: '自チームのターンオーバー', unit: '本', calc: (t) => t.us.to },
  { key: 'opp_to', label: '相手のターンオーバー', unit: '本', calc: (t) => t.opp.to },
  { key: 'us_or', label: '自チームのOR', unit: '本', calc: (t) => t.us.oreb },
  { key: 'opp_or', label: '相手のOR', unit: '本', calc: (t) => t.opp.oreb },
  { key: 'us_dr', label: '自チームのDR', unit: '本', calc: (t) => t.us.dreb },
  { key: 'opp_dr', label: '相手のDR', unit: '本', calc: (t) => t.opp.dreb },
  { key: 'us_or_pct', label: '自チームのOR率', unit: '%', calc: (t) => (t.ind.us.orPct == null ? null : t.ind.us.orPct * 100) },
  { key: 'us_fg_pct', label: '自チームのFG%', unit: '%', calc: (t) => pct(t.us.fgm, t.us.fga) },
  { key: 'us_3p_pct', label: '自チームの3P%', unit: '%', calc: (t) => pct(t.us.tpm, t.us.tpa) },
  { key: 'us_ft_pct', label: '自チームのFT%', unit: '%', calc: (t) => pct(t.us.ftm, t.us.fta) },
  { key: 'opp_fg_pct', label: '相手のFG%', unit: '%', calc: (t) => pct(t.opp.fgm, t.opp.fga) },
  { key: 'opp_3p_pct', label: '相手の3P%', unit: '%', calc: (t) => pct(t.opp.tpm, t.opp.tpa) },
  { key: 'us_3pa', label: '自チームの3P試投', unit: '本', calc: (t) => t.us.tpa },
  { key: 'us_fta', label: '自チームのFT試投', unit: '本', calc: (t) => t.us.fta },
  { key: 'us_pf', label: '自チームのファウル', unit: '回', calc: (t) => t.us.pf },
  { key: 'opp_pf', label: '相手のファウル', unit: '回', calc: (t) => t.opp.pf },
  { key: 'us_ast', label: '自チームのアシスト', unit: '本', calc: (t) => t.us.ast },
  { key: 'us_stl', label: '自チームのスティール', unit: '本', calc: (t) => t.us.stl },
  { key: 'us_second', label: '自チームのセカンドチャンス得点', unit: '点', calc: (t) => t.usSecond },
  { key: 'opp_second', label: '相手のセカンドチャンス得点', unit: '点', calc: (t) => t.oppSecond },
  { key: 'us_fastbreak', label: '自チームの速攻得点', unit: '点', calc: (t) => t.usFast },
  { key: 'opp_fastbreak', label: '相手の速攻得点', unit: '点', calc: (t) => t.oppFast },
];

export const METRIC_BY_KEY = Object.fromEntries(CHECK_METRICS.map((m) => [m.key, m]));

function totals(events) {
  return {
    us: teamBox(events, 'us').total,
    opp: teamBox(events, 'opp').total,
    ind: teamIndicators(events),
    usSecond: taggedPoints(events, 'us', 'セカンドチャンス'),
    oppSecond: taggedPoints(events, 'opp', 'セカンドチャンス'),
    usFast: taggedPoints(events, 'us', '速攻'),
    oppFast: taggedPoints(events, 'opp', '速攻'),
  };
}

/** その試合の数字（割合は % の値）。計算できなければ null */
export function metricValue(key, events) {
  const m = METRIC_BY_KEY[key];
  if (!m) return null;
  const v = m.calc(totals(events));
  return v == null || !Number.isFinite(v) ? null : v;
}

function numText(v, unit) {
  if (v == null) return '—';
  return unit === '%' ? `${Math.round(v)}%` : `${v}${unit}`;
}

/** 「ターンオーバー12本以下」のような目標の文言 */
export function targetText(target) {
  const m = target && METRIC_BY_KEY[target.key];
  if (!m) return '';
  return `${m.label} ${numText(Number(target.value), m.unit)}${target.op === 'ge' ? '以上' : '以下'}`;
}

/**
 * 目標の自動判定。
 * 戻り値 = { value, ok: true|false|null, mark: '◯'|'×'|null, text }
 */
export function evaluateTarget(target, events) {
  const m = target && METRIC_BY_KEY[target.key];
  if (!m || target.value === '' || target.value == null || !Number.isFinite(Number(target.value))) {
    return { value: null, ok: null, mark: null, text: '' };
  }
  const value = metricValue(target.key, events);
  if (value == null) return { value, ok: null, mark: null, text: `${m.label} —（記録なし）` };
  const goal = Number(target.value);
  const ok = target.op === 'ge' ? value >= goal : value <= goal;
  return { value, ok, mark: ok ? '◯' : '×', text: `${m.label} ${numText(value, m.unit)}（目標 ${numText(goal, m.unit)}${target.op === 'ge' ? '以上' : '以下'}）` };
}

export const MARKS = ['◯', '△', '×'];

/**
 * 試合のチェック（game.checklist）とテンプレートを合わせる。
 * 試合に保存済みならその内容（項目名・目標は評価したときのまま）を使い、テンプレートにしかない項目は missing に入れる。
 */
export function mergeChecklist(gameChecklist = [], template = []) {
  if (!gameChecklist.length) {
    return { items: template.map((t) => ({ itemId: t.id, label: t.label, target: t.target || null, mark: null, memo: '' })), missing: [], saved: false };
  }
  const have = new Set(gameChecklist.map((c) => c.itemId));
  return { items: gameChecklist.map((c) => ({ ...c })), missing: template.filter((t) => !have.has(t.id)), saved: true };
}

/** チェック項目の例（SPEC 6-2 の例。設定画面の「例を入れる」で使う） */
export const CHECK_EXAMPLES = [
  { label: 'ボックスアウト', target: null },
  { label: 'トランジションで3線を走る', target: null },
  { label: 'ヘルプの位置', target: null },
  { label: 'ターンオーバー12以下', target: { key: 'us_to', op: 'le', value: 12 } },
  { label: '相手OR 8以下', target: { key: 'opp_or', op: 'le', value: 8 } },
];

/** 延長も含めたクォーターの選択肢（動画の対象用） */
export function videoQuarterOptions(maxQuarter = REGULAR_QUARTERS) {
  const n = Math.max(REGULAR_QUARTERS + 2, maxQuarter);
  return [{ value: '', label: '試合全体' }, ...Array.from({ length: n }, (_, i) => ({ value: String(i + 1), label: quarterLabel(i + 1) }))];
}
