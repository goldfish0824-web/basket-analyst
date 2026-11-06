// イベント・試合データの形と、表示用の文言（SPEC 3-2, 3-3, 3-5）。すべて純粋関数。

export const TEAMS = ['us', 'opp'];
export const TEAM_LABEL = { us: '自チーム', opp: '相手' };
export const TEAM_SHORT = { us: '自', opp: '相手' };

export const EVENT_TYPES = [
  'fg', 'ft', 'oreb', 'dreb', 'to', 'ast', 'stl', 'blk', 'foul', 'timeout', 'adjust', 'q_start', 'q_end', 'sub', 'lineup',
];

// 「TO」はターンオーバー／タイムアウトのどちらにも読めるので使わない（CLAUDE.md）
export const TYPE_LABEL = {
  fg: 'フィールドゴール',
  ft: 'フリースロー',
  oreb: 'OR',
  dreb: 'DR',
  to: 'ターンオーバー',
  ast: 'アシスト',
  stl: 'スティール',
  blk: 'ブロック',
  foul: 'ファウル',
  timeout: 'タイムアウト',
  adjust: '得点補正',
  q_start: 'クォーター開始',
  q_end: 'クォーター終了',
  sub: '選手交代',
  lineup: '出場メンバー',
};

export const DEFAULT_DEFENSES = [
  'マンツー',
  '2-3ゾーン',
  '3-2ゾーン',
  '1-3-1ゾーン',
  '変則（ボックスワン等）',
  'オールコートマンツー',
  '2-2-1プレス',
  '1-2-1-1プレス',
  'その他',
];

export const SHOT_TAGS = ['ドライブ', 'ジャンプシュート', 'ポスト', '速攻', 'セカンドチャンス'];
export const TO_TAGS = ['パスミス', 'キャッチミス', 'トラベリング', 'オフェンスファウル', '時間のバイオレーション', 'スティールされた', 'その他'];

export const REGULAR_QUARTERS = 4;

// 攻撃側のプレー → 守っている側（相手）の隊形を付ける
const OFFENSE_TYPES = new Set(['fg', 'ft', 'oreb', 'to', 'ast']);
// 守備側のプレー → 自分たちの隊形を付ける（ファウルは守備時のものとして扱う）
const DEFENSE_TYPES = new Set(['dreb', 'stl', 'blk', 'foul']);

export function otherTeam(team) {
  return team === 'us' ? 'opp' : 'us';
}

export function quarterLabel(q) {
  if (!q) return '';
  return q <= REGULAR_QUARTERS ? `${q}Q` : `延長${q - REGULAR_QUARTERS}`;
}

/**
 * イベントに付ける守備隊形（SPEC 3-3）。
 * live = { usDF, oppDF }（いま記録者が選んでいる隊形）
 */
export function defenseFor(type, team, live) {
  const side = defenseSide(type, team);
  if (!side || !live) return null;
  return (side === 'us' ? live.usDF : live.oppDF) || null;
}

/** そのプレーのとき守っているチーム（隊形を付けないプレーは null） */
export function defenseSide(type, team) {
  if (team !== 'us' && team !== 'opp') return null;
  if (OFFENSE_TYPES.has(type)) return otherTeam(team);
  if (DEFENSE_TYPES.has(type)) return team;
  return null;
}

export function uuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nextSeq(events) {
  let max = 0;
  for (const e of events) if (e.seq > max) max = e.seq;
  return max + 1;
}

export function sortEvents(events) {
  return [...events].sort((a, b) => a.seq - b.seq);
}

/**
 * クォーターの状態をイベントから求める。
 * phase: 'pre'（試合開始前）／'live'（クォーター中）／'break'（クォーター間）
 */
export function quarterState(events) {
  let last = null;
  for (const e of sortEvents(events)) {
    if (e.type === 'q_start' || e.type === 'q_end') last = e;
  }
  if (!last) return { phase: 'pre', quarter: 1, next: 1 };
  if (last.type === 'q_start') return { phase: 'live', quarter: last.quarter, next: last.quarter + 1 };
  return { phase: 'break', quarter: last.quarter, next: last.quarter + 1 };
}

/**
 * 下書き（team, player, type, made, points, x, y, zone, tags）から保存する形のイベントを作る。
 * ctx = { gameId, seq, quarter, live: {usDF, oppDF}, ts, id }
 */
export function makeEvent(draft, ctx) {
  const type = draft.type;
  const team = draft.team ?? null;
  const isShot = type === 'fg';
  const hasResult = type === 'fg' || type === 'ft' || type === 'adjust';
  const isAdjust = type === 'adjust';
  return {
    id: draft.id || ctx.id || uuid(),
    gameId: ctx.gameId,
    seq: ctx.seq,
    quarter: ctx.quarter,
    team,
    player: draft.player == null || draft.player === '' ? null : String(draft.player),
    type,
    made: hasResult ? (isAdjust ? true : !!draft.made) : null,
    // points は「その試投の価値」（2P=2, 3P=3, FT=1, 得点補正=+n）。得点になるのは made のときだけ
    points: hasResult ? Number(draft.points) : null,
    x: isShot ? round2(draft.x) : null,
    y: isShot ? round2(draft.y) : null,
    zone: isShot ? draft.zone : null,
    tags: Array.isArray(draft.tags) ? [...draft.tags] : [],
    // 得点補正は後から合わせる記録なので隊形は付けない
    defense: isAdjust ? null : defenseFor(type, team, ctx.live),
    ts: ctx.ts,
    // 試合時計の残り秒（時計を使っていなければ null）
    clock: draft.clock != null ? Number(draft.clock) : ctx.clock != null ? Number(ctx.clock) : null,
    // 選手交代：出た選手（player は入った選手）／出場メンバー：コートの5人
    ...(type === 'sub' ? { out: draft.out == null ? null : String(draft.out) } : {}),
    ...(type === 'lineup' ? { players: (draft.players || []).map(String) } : {}),
  };
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}

/** 「自#7」「相手#12」「自チーム」「相手」 */
export function whoLabel(team, player) {
  if (!team) return '';
  if (player == null) return TEAM_LABEL[team];
  return `${TEAM_SHORT[team]}#${player}`;
}

/** 記録ログなどに出す1行の説明 */
export function describeEvent(e, zoneLabels) {
  const who = whoLabel(e.team, e.player);
  const tagText = e.tags && e.tags.length ? `（${e.tags.join('・')}）` : '';
  switch (e.type) {
    case 'fg': {
      const zone = zoneLabels && e.zone ? zoneLabels[e.zone] || e.zone : e.zone || '';
      return `${who} ${e.points === 3 ? '3P' : '2P'}${e.made ? '成功' : '失敗'} ${zone}${tagText}`.trim();
    }
    case 'ft':
      return `${who} FT${e.made ? '成功' : '失敗'}`;
    case 'to':
      return `${who} ターンオーバー${tagText}`;
    case 'timeout':
      return `タイムアウト（${TEAM_LABEL[e.team] || ''}）`;
    case 'adjust':
      return `得点補正 ${TEAM_LABEL[e.team] || ''} +${e.points}`;
    case 'q_start':
      return `${quarterLabel(e.quarter)} 開始`;
    case 'q_end':
      return `${quarterLabel(e.quarter)} 終了`;
    case 'sub':
      return `交代 ${TEAM_SHORT[e.team] || ''}#${e.out} → #${e.player}`;
    case 'lineup':
      return `出場メンバー ${TEAM_SHORT[e.team] || ''}${(e.players || []).map((n) => `#${n}`).join('・')}`;
    default:
      return `${who} ${TYPE_LABEL[e.type] || e.type}`;
  }
}

export function sortNumbers(nums) {
  return [...nums].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    // "0" と "00" のように数値が同じ場合は文字数で
    if (String(a).length !== String(b).length) return String(a).length - String(b).length;
    return String(a).localeCompare(String(b));
  });
}

/** 新しい試合の形（SPEC 3-5） */
export function newGame({ id, date, tournament = '', opponent = '', roster = [], oppNumbers = [], videos = [], defenses }) {
  const first = (defenses && defenses[0]) || DEFAULT_DEFENSES[0];
  return {
    id: id || uuid(),
    date,
    tournament,
    opponent,
    roster: roster.map((p) => ({ number: String(p.number), name: p.name || '' })),
    oppNumbers: sortNumbers(oppNumbers.map(String)),
    videos,
    checklist: [],
    insights: [],
    // AIに聞いた「対処の例」（クォーター終了画面）
    advice: [],
    // 試合後の AIふりかえり
    reports: [],
    // 記録中の状態（いまの守備隊形）。イベントには記録時の隊形がそれぞれ付く
    live: { usDF: first, oppDF: first },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** 日付の降順（同じ日なら作成の新しい順） */
export function sortGames(games) {
  return [...games].sort((a, b) => {
    if ((a.date || '') !== (b.date || '')) return (b.date || '').localeCompare(a.date || '');
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

/** 「4 5 7、10」→ ['4','5','7','10'] */
export function parseNumberList(text) {
  const parts = String(text || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .split(/[\s,、，・]+/)
    .filter(Boolean);
  const bad = parts.filter((p) => !/^\d{1,2}$/.test(p));
  return { numbers: [...new Set(parts.filter((p) => /^\d{1,2}$/.test(p)))], bad };
}
