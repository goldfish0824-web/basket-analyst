// 記録画面の入力の流れ（SPEC 3-2）を純粋関数の状態遷移として書く。
// 画面側は step() の結果（ops）を保存し、state を描き直すだけにする。
//
// どのプレーも「選手 → ボタン」「ボタン → 選手」のどちらの順でも記録できる。
// フィールドゴールは「コート → 選手 → 成功／失敗」（選手を先に選んでからコートでもよい）。
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
  };
}

function reset(state, keep = {}) {
  return { ...initialInput(), team: state.team, ...keep };
}

function closeTransient(state) {
  // 種類タグ・タイムアウト・得点補正の選択は、ほかの操作を始めたら閉じる
  if (state.sheet === 'tags' || state.sheet === 'timeout' || state.sheet === 'adjust') {
    return { ...state, sheet: null, tagKind: null, tagEventId: null, tags: [] };
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
      return { state: reset(state, { sheet: 'tags', tagKind: 'fg', tagEventId: id }), ops: [{ op: 'add', draft }] };
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
  if (state.loc && !state.sel) {
    return state.team === 'opp'
      ? 'シュート位置 → 選手を選ぶ（番号が分からなければ「番号なし」）'
      : 'シュート位置 → 選手を選ぶ';
  }
  if (state.action && !state.sel) {
    const label = ACTIONS[state.action].label;
    if (state.team === 'opp') return `${label}：選手を選ぶ（番号が分からなければ「番号なし」）`;
    if (US_TEAM_OK.has(state.action)) return `${label}：選手を選ぶ（選手なしは「チーム」）`;
    return `${label}：選手を選ぶ`;
  }
  if (state.sel) return `${whoLabel(state.sel.team, state.sel.player)} を選択中 → プレーを選ぶ／コートをタップ`;
  return 'コートをタップ → シュート　／　選手 → プレー';
}

