// 記録画面の入力の流れ（SPEC 3-2）を純粋関数の状態遷移として書く。
// 画面側は step() の結果（ops）を保存し、state を描き直すだけにする。
//
// どのプレーも「選手 → ボタン」「ボタン → 選手」のどちらの順でも記録できる。
// フィールドゴールは「コート → 選手 → 成功／失敗」（選手を先に選んでからコートでもよい）。
// シュート・フリースローの直後は、続きのプレーを1タップで記録できる（アシスト、リバウンド、2本目のフリースロー）。
import { isThree, zoneOf } from './court.js';
import { whoLabel } from './model.js';

export const ACTIONS = {
  ft_made: { label: 'FT成功', draft: { type: 'ft', made: true, points: 1 } },
  ft_miss: { label: 'FT失敗', draft: { type: 'ft', made: false, points: 1 } },
  oreb: { label: 'OR', draft: { type: 'oreb' } },
  dreb: { label: 'DR', draft: { type: 'dreb' } },
  to: { label: 'ターンオーバー', draft: { type: 'to' } },
  ast: { label: 'アシスト', draft: { type: 'ast' } },
  stl: { label: 'スティール', draft: { type: 'stl' } },
  blk: { label: 'ブロック', draft: { type: 'blk' } },
  foul: { label: 'ファウル', draft: { type: 'foul' } },
};

/** 自チームだけのプレー（SPEC：アシスト・スティール・ブロックは自チームのみ） */
export const US_ONLY = new Set(['ast', 'stl', 'blk']);
/** 自チームで「チーム」（選手なし）を選べるプレー */
export const US_TEAM_OK = new Set(['oreb', 'dreb', 'to']);

export function initialInput() {
  return {
    team: 'us', // 選手ボタンに表示しているチーム
    sel: null, // { team, player }  player は背番号の文字列、または null（チーム／番号なし）
    loc: null, // { x, y } シュート位置（選手・結果待ち）
    three: false, // シュートが3Pか（位置から自動判定、記録者が切り替え可）
    action: null, // 選手待ちのプレー（ACTIONS のキー）
    sheet: null, // 'fg'（成功／失敗）| 'tags' | 'timeout' | 'adjust'
    tagKind: null, // 'fg' | 'to'
    tagEventId: null,
    tags: [],
    // 直前のシュート・フリースロー（続きのプレーの1タップ記録に使う）{ kind: 'fg'|'ft', team, player, made }
    after: null,
    assistId: null, // 続けて記録したアシストのイベント
    assistPlayer: null,
  };
}

function reset(state, keep = {}) {
  return { ...initialInput(), team: state.team, ...keep };
}

function closeTransient(state) {
  // 種類タグ・フリースローの続き・タイムアウト・得点補正の選択は、ほかの操作を始めたら閉じる
  if (['tags', 'ft', 'timeout', 'adjust'].includes(state.sheet)) {
    return { ...state, sheet: null, tagKind: null, tagEventId: null, tags: [], after: null, assistId: null, assistPlayer: null };
  }
  return state;
}

function canBeNull(team, action) {
  return team === 'opp' || US_TEAM_OK.has(action);
}

function recordAction(state, action, who, ctx) {
  const def = ACTIONS[action];
  if (!def) return { state, ops: [], error: '不明なプレーです' };
  if (US_ONLY.has(action) && who.team !== 'us') {
    return { state: reset(state), ops: [], error: `${def.label}は自チームだけ記録します` };
  }
  if (who.player == null && !canBeNull(who.team, action)) {
    return { state: { ...state, sel: null, action }, ops: [], error: `${def.label}は選手を選んでください` };
  }
  const id = ctx.newId();
  const draft = { id, team: who.team, player: who.player, ...def.draft, tags: [] };
  const ops = [{ op: 'add', draft }];
  if (action === 'to') {
    return { state: reset(state, { sheet: 'tags', tagKind: 'to', tagEventId: id }), ops };
  }
  if (action === 'ft_made' || action === 'ft_miss') {
    return { state: reset(state, { sheet: 'ft', tagEventId: id, after: { kind: 'ft', team: who.team, player: who.player, made: action === 'ft_made' } }), ops };
  }
  return { state: reset(state), ops };
}

/**
 * 入力1回ぶんの状態遷移。
 * ctx = { newId: () => string, isDisabled?: (team, player) => boolean }
 * 戻り値 = { state, ops: [{op:'add', draft} | {op:'patch', id, patch}], error? }
 */
export function step(state, cmd, ctx) {
  const disabled = ctx.isDisabled || (() => false);
  switch (cmd.type) {
    case 'team': {
      if (cmd.team === state.team) return { state, ops: [] };
      let s = closeTransient(state);
      // 選んでいた選手は別チームなので外す。シュート位置・選手待ちのプレーは残す
      s = { ...s, team: cmd.team, sel: null, sheet: s.sheet === 'fg' ? null : s.sheet };
      return { state: s, ops: [] };
    }

    case 'court': {
      const s = closeTransient(state);
      const loc = { x: cmd.x, y: cmd.y };
      const three = isThree(cmd.x, cmd.y);
      const sheet = s.sel ? 'fg' : null;
      return { state: { ...s, loc, three, action: null, sheet }, ops: [] };
    }

    case 'player': {
      const player = cmd.player == null ? null : String(cmd.player);
      if (player != null && disabled(cmd.team, player)) {
        return { state, ops: [], error: `${whoLabel(cmd.team, player)} は5ファウルです` };
      }
      const s = closeTransient(state);
      const who = { team: cmd.team, player };
      if (s.loc) {
        if (player == null && cmd.team === 'us') {
          return { state: s, ops: [], error: 'シュートは選手を選んでください' };
        }
        return { state: { ...s, sel: who, sheet: 'fg' }, ops: [] };
      }
      if (s.action) return recordAction(s, s.action, who, ctx);
      const same = s.sel && s.sel.team === who.team && s.sel.player === who.player;
      return { state: { ...s, sel: same ? null : who }, ops: [] };
    }

    case 'play': {
      const action = cmd.action;
      let s = closeTransient(state);
      if (s.loc) s = { ...s, loc: null, sheet: null }; // シュート入力をやめて別のプレーへ
      if (s.action === action && !s.sel) return { state: { ...s, action: null }, ops: [] }; // もう一度押したら取りやめ
      if (s.sel) return recordAction(s, action, s.sel, ctx);
      if (US_ONLY.has(action) && s.team !== 'us') {
        return { state: s, ops: [], error: `${ACTIONS[action].label}は自チームだけ記録します` };
      }
      return { state: { ...s, action }, ops: [] };
    }

    case 'toggle3': {
      if (!state.loc) return { state, ops: [] };
      return { state: { ...state, three: !state.three }, ops: [] };
    }

    case 'fgResult': {
      if (!state.loc || !state.sel) return { state, ops: [], error: '位置と選手を選んでください' };
      const { x, y } = state.loc;
      const id = ctx.newId();
      const draft = {
        id,
        team: state.sel.team,
        player: state.sel.player,
        type: 'fg',
        made: !!cmd.made,
        points: state.three ? 3 : 2,
        x,
        y,
        zone: zoneOf(x, y, state.three),
        tags: [],
      };
      const after = { kind: 'fg', team: draft.team, player: draft.player, made: draft.made };
      return { state: reset(state, { sheet: 'tags', tagKind: 'fg', tagEventId: id, after }), ops: [{ op: 'add', draft }] };
    }

    case 'assist': {
      // 自チームのシュート成功の直後：アシストした選手を1タップ（もう一度押すと取り消し、別の選手を押すと付け替え）
      const a = state.after;
      if (!a || a.kind !== 'fg' || !a.made || a.team !== 'us') return { state, ops: [] };
      const player = String(cmd.player);
      if (player === a.player) return { state, ops: [], error: 'シュートした選手はアシストにできません' };
      const ops = state.assistId ? [{ op: 'remove', id: state.assistId }] : [];
      if (state.assistPlayer === player) return { state: { ...state, assistId: null, assistPlayer: null }, ops };
      const id = ctx.newId();
      ops.push({ op: 'add', draft: { id, team: 'us', player, type: 'ast', tags: [] } });
      return { state: { ...state, assistId: id, assistPlayer: player }, ops };
    }

    case 'rebound': {
      // シュート・フリースロー失敗の直後：リバウンドを1タップ（シュートしたチームなら OR、相手なら DR）
      const a = state.after;
      if (!a || a.made) return { state, ops: [] };
      const team = cmd.team === 'opp' ? 'opp' : 'us';
      const player = cmd.player == null ? null : String(cmd.player);
      if (player != null && disabled(team, player)) {
        return { state, ops: [], error: `${whoLabel(team, player)} は5ファウルです` };
      }
      const draft = { id: ctx.newId(), team, player, type: team === a.team ? 'oreb' : 'dreb', tags: [] };
      return { state: reset(state), ops: [{ op: 'add', draft }] };
    }

    case 'ftAgain': {
      // フリースローの直後：同じ選手の次の1本
      const a = state.after;
      if (!a || a.kind !== 'ft') return { state, ops: [] };
      const id = ctx.newId();
      const draft = { id, team: a.team, player: a.player, ...ACTIONS[cmd.made ? 'ft_made' : 'ft_miss'].draft, tags: [] };
      return { state: reset(state, { sheet: 'ft', tagEventId: id, after: { ...a, made: !!cmd.made } }), ops: [{ op: 'add', draft }] };
    }

    case 'tag': {
      if (state.sheet !== 'tags' || !state.tagEventId) return { state, ops: [] };
      const has = state.tags.includes(cmd.tag);
      const tags = has ? state.tags.filter((t) => t !== cmd.tag) : [...state.tags, cmd.tag];
      return { state: { ...state, tags }, ops: [{ op: 'patch', id: state.tagEventId, patch: { tags } }] };
    }

    case 'sheet': {
      // タイムアウト・得点補正の選択を開く（もう一度押すと閉じる）
      if (state.sheet === cmd.sheet) return { state: { ...state, sheet: null }, ops: [] };
      return { state: reset(state, { sheet: cmd.sheet }), ops: [] };
    }

    case 'timeout': {
      const draft = { id: ctx.newId(), team: cmd.team, player: null, type: 'timeout', tags: [] };
      return { state: reset(state), ops: [{ op: 'add', draft }] };
    }

    case 'adjust': {
      const points = Number(cmd.points);
      if (![1, 2, 3].includes(points)) return { state, ops: [], error: '補正は +1 / +2 / +3 です' };
      const draft = { id: ctx.newId(), team: cmd.team, player: null, type: 'adjust', made: true, points, tags: [] };
      return { state: reset(state), ops: [{ op: 'add', draft }] };
    }

    case 'cancel':
      return { state: reset(state), ops: [] };

    default:
      return { state, ops: [] };
  }
}

/** いま何を待っているかの案内文（操作の案内だけ。戦術の指示は書かない） */
export function hintFor(state) {
  if (state.loc && !state.sel) return 'シュート位置 → 選手を選ぶ（相手の番号が分からなければ「番号なし」）';
  if (state.action && !state.sel) {
    const label = ACTIONS[state.action].label;
    if (US_ONLY.has(state.action)) return `${label}：自チームの選手を選ぶ`;
    if (US_TEAM_OK.has(state.action)) return `${label}：選手を選ぶ（選手なしは「チーム」／相手は「番号なし」も可）`;
    return `${label}：選手を選ぶ（相手の番号が分からなければ「番号なし」）`;
  }
  if (state.sel) return `${whoLabel(state.sel.team, state.sel.player)} を選択中 → プレーを選ぶ／コートをタップ`;
  return 'コートをタップ → シュート　／　選手 → プレー';
}

