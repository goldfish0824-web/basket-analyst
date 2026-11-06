// デモ試合データ（SPEC 8章）。名前・学校名はすべて架空。
// 集計・シュートチャート・AIなし抽出の確認用に、偏りのある場面を意図的に入れてある：
//   - 相手#7 のドライブが多く、よく決まる
//   - 2Q の相手 2-3ゾーンに対して自チームの3Pが入らない
//   - 3Q の相手 2-2-1プレスで自チームのターンオーバーが続く
//   - 自#5 のファウルが前半3つ、3Qで4つ。相手#10 は4Qに5つ目
//   - 相手のオフェンスリバウンドが多い、自チームのフリースローが入らない
//   - 両チームの先発と交代、試合時計の残り時間（出場時間・+/- の確認用）
import { COURT_W, zoneOf, zonePolygons } from './court.js';
import { makeEvent, newGame, uuid } from './model.js';

export const DEMO_ROSTER = [
  { number: '4', name: 'アオイ' },
  { number: '5', name: 'ユイ' },
  { number: '6', name: 'サキ' },
  { number: '7', name: 'リコ' },
  { number: '8', name: 'ナナ' },
  { number: '9', name: 'メイ' },
  { number: '10', name: 'ハル' },
  { number: '11', name: 'ミオ' },
  { number: '12', name: 'カエデ' },
  { number: '13', name: 'ノア' },
];

export const DEMO_OPP_NUMBERS = ['4', '5', '6', '7', '8', '9', '10', '12', '15'];

const U = 'us';
const O = 'opp';

// [種類, ...] の並び。'df' は守備隊形の切り替え（イベントではない）
const SCRIPT = [
  // 1Q：両チーム マンツー
  [
    ['fg', U, '4', 'ゴール下', true, ['ドライブ']],
    ['ast', '7'],
    ['fg', O, '7', 'ミドル右', true, ['ドライブ']],
    ['fg', U, '7', '3P右45度', false, ['ジャンプシュート']],
    ['dr', O, '4'],
    ['fg', O, '4', 'ゴール下', true, ['ポスト']],
    ['foul', U, '5'],
    ['fg', U, '6', 'ミドル左', true, ['ジャンプシュート']],
    ['fg', O, '7', 'ゴール下', true, ['ドライブ']],
    ['to', U, '8', ['パスミス']],
    ['fg', O, '12', '3P左コーナー', false],
    ['dr', U, '4'],
    ['fg', U, '4', '3P左45度', true, ['ジャンプシュート']],
    ['ast', '5'],
    ['foul', O, '10'],
    ['fg', O, '7', 'ミドル右', false, ['ドライブ']],
    ['or', O, '4'],
    ['fg', O, '4', 'ゴール下', true, ['セカンドチャンス', 'ポスト']],
    ['stl', '5'],
    ['fg', U, '5', 'ゴール下', true, ['速攻']],
    ['foul', U, '5'],
    ['ft', O, '9', true],
    ['ft', O, '9', false],
    ['dr', U, '6'],
    ['fg', U, '7', '3Pトップ', false],
    ['dr', O, '9'],
    ['fg', O, '5', 'ミドル中央', true, ['ジャンプシュート']],
    ['timeout', U],
    ['fg', U, '8', 'ミドル右', true],
  ],
  // 2Q：相手が 2-3ゾーン
  [
    ['df', O, '2-3ゾーン'],
    ['fg', U, '7', '3P右45度', false],
    ['dr', O, '5'],
    ['fg', O, '7', 'ミドル右', true, ['ドライブ']],
    ['fg', U, '4', '3P左45度', false],
    ['or', U, '6'],
    ['fg', U, '6', 'ゴール下', true, ['セカンドチャンス']],
    ['fg', O, '4', 'ゴール下', true, ['ポスト']],
    ['fg', U, '8', '3Pトップ', false],
    ['dr', O, '4'],
    ['fg', O, '12', '3P右45度', true],
    ['foul', U, '5'],
    ['fg', U, '7', '3P左コーナー', true],
    ['ast', '4'],
    ['fg', O, '7', 'ゴール下', true, ['ドライブ']],
    ['fg', U, '4', '3P右コーナー', false],
    ['dr', O, '9'],
    ['fg', O, '9', 'ミドル左', false],
    ['or', O, '4'],
    ['fg', O, '4', 'ゴール下', true, ['セカンドチャンス']],
    ['to', U, '10', ['キャッチミス']],
    ['fg', O, '5', '3Pトップ', true, ['速攻']],
    ['fg', U, '9', '3P左45度', false],
    ['dr', O, '5'],
    ['foul', O, '10'],
    ['fg', U, '7', '3Pトップ', false],
    ['dr', O, '4'],
    ['fg', O, '7', 'ミドル中央', false, ['ジャンプシュート']],
    ['dr', U, '5'],
    ['fg', U, '5', 'ゴール下', true, ['ドライブ']],
    ['fg', U, '8', '3P右45度', false],
    ['dr', O, '7'],
    ['fg', O, '15', 'ミドル右', true],
  ],
  // 3Q：相手が 2-2-1プレス、自チームは 2-3ゾーン
  [
    ['df', O, '2-2-1プレス'],
    ['df', U, '2-3ゾーン'],
    ['to', U, '8', ['パスミス']],
    ['fg', O, '5', 'ゴール下', true, ['速攻']],
    ['to', U, '4', ['スティールされた']],
    ['fg', O, '9', 'ゴール下', false, ['速攻']],
    ['dr', U, '6'],
    ['fg', U, '6', 'ミドル右', true, ['ジャンプシュート']],
    ['foul', O, '10'],
    ['to', U, '7', ['トラベリング']],
    ['fg', O, '12', '3P左45度', false],
    ['or', O, '8'],
    ['fg', O, '8', 'ミドル右', false],
    ['dr', U, '4'],
    ['fg', U, '4', 'ゴール下', true, ['速攻']],
    ['foul', U, '5'],
    ['ft', O, '4', true],
    ['ft', O, '4', true],
    ['to', U, '9', ['時間のバイオレーション']],
    ['timeout', U],
    ['fg', O, '7', 'ミドル右', false, ['ドライブ']],
    ['blk', '6'],
    ['dr', U, '6'],
    ['fg', U, '7', '3P右コーナー', true],
    ['foul', O, '10'],
    ['fg', O, '4', 'ゴール下', true, ['ポスト']],
    ['df', O, 'マンツー'],
    ['to', U, '6', ['パスミス']],
  ],
  // 4Q：両チーム マンツー
  [
    ['df', U, 'マンツー'],
    ['fg', U, '4', '3P左45度', true, ['ジャンプシュート']],
    ['ast', '8'],
    ['fg', O, '7', 'ミドル右', true, ['ドライブ']],
    ['foul', O, '9'],
    ['ft', U, '7', true],
    ['ft', U, '7', false],
    ['dr', O, '4'],
    ['fg', O, '4', 'ゴール下', false],
    ['or', O, '4'],
    ['fg', O, '4', 'ゴール下', true, ['セカンドチャンス']],
    ['stl', '8'],
    ['fg', U, '8', 'ゴール下', true, ['速攻']],
    ['fg', O, '12', '3P右コーナー', true],
    ['fg', U, '6', 'ミドル中央', true, ['ジャンプシュート']],
    ['ast', '4'],
    ['foul', O, '5'],
    ['ft', U, '4', false],
    ['ft', U, '4', false],
    ['dr', O, '5'],
    ['stl', '7'],
    ['to', O, '7', ['スティールされた']],
    ['fg', U, '7', 'ゴール下', true, ['速攻']],
    ['adjust', U, 2],
    ['timeout', O],
    ['fg', O, '7', 'ゴール下', false, ['ドライブ']],
    ['dr', U, '6'],
    ['foul', O, '10'],
    ['ft', U, '6', true],
    ['ft', U, '6', false],
    ['fg', O, '5', '3Pトップ', false],
    ['or', O, '9'],
    ['fg', O, '9', 'ゴール下', true, ['セカンドチャンス']],
  ],
];

/** 再現できる乱数（mulberry32） */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bbox(poly) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { x1: Math.min(...xs), x2: Math.max(...xs), y1: Math.min(...ys), y2: Math.max(...ys) };
}

/** ゾーンの中のそれらしい位置（3Pはラインから離れすぎない、ゴール下の真下は避ける） */
export function pointInZone(zone, rand) {
  const b = bbox(zonePolygons()[zone]);
  const maxY = zone.startsWith('3P') ? 9.6 : b.y2;
  for (let i = 0; i < 2000; i++) {
    const x = b.x1 + rand() * (b.x2 - b.x1);
    const y = b.y1 + rand() * (Math.min(b.y2, maxY) - b.y1);
    if (y < 0.4 || x < 0.15 || x > COURT_W - 0.15) continue;
    if (zone.startsWith('3P') && Math.hypot(x - 7.5, y - 1.575) > 8.6) continue;
    if (zoneOf(x, y) === zone) return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
  }
  throw new Error(`ゾーン内の点が見つかりません: ${zone}`);
}

function localDateString(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * デモ試合を作る。
 * opts = { seed, now, newId, defenses }
 * 戻り値 = { game, events }（約120イベント）
 */
export function generateDemo(opts = {}) {
  const seed = opts.seed ?? 20261103;
  const now = opts.now ?? Date.now();
  const newId = opts.newId || uuid;
  const rand = seededRandom(seed);

  const date = localDateString(now);
  const start = new Date(`${date}T10:00:00`).getTime();
  const game = newGame({
    id: newId(),
    date,
    tournament: 'デモ大会（架空）',
    opponent: 'さくら台高校（架空）',
    roster: DEMO_ROSTER,
    oppNumbers: DEMO_OPP_NUMBERS,
    defenses: opts.defenses,
  });
  game.createdAt = now;
  game.updatedAt = now;
  game.isDemo = true;

  const live = { usDF: 'マンツー', oppDF: 'マンツー' };
  const events = [];
  let seq = 0;
  let ts = start;
  const push = (draft, quarter, stepMs) => {
    seq += 1;
    ts += stepMs ?? 15000 + Math.floor(rand() * 25000);
    events.push(makeEvent(draft, { gameId: game.id, seq, quarter, live: { ...live }, ts, id: newId() }));
  };

  // 先発（両チーム）。記録に出てくる選手がベンチにいたら、その前に交代を入れる
  // （出す選手は、このクォーターでいちばん後まで記録に出てこない選手）
  const playerOf = (it, team) => {
    if (team === U && (it[0] === 'ast' || it[0] === 'stl' || it[0] === 'blk')) return it[1];
    return it[1] === team && it[2] != null && ['fg', 'ft', 'or', 'dr', 'to', 'foul'].includes(it[0]) ? it[2] : null;
  };
  const firstFive = (team) => [...new Set(SCRIPT.flat().map((it) => playerOf(it, team)).filter((n) => n != null))].slice(0, 5);
  const courts = { [U]: DEMO_ROSTER.slice(0, 5).map((p) => p.number), [O]: firstFive(O) };
  ts = start - 120000;
  push({ type: 'lineup', team: U, players: courts[U] }, 1, 0);
  push({ type: 'lineup', team: O, players: courts[O] }, 1, 1000);
  const ensureOnCourt = (team, items, from, quarter) => {
    const player = playerOf(items[from], team);
    const court = courts[team];
    if (player == null || court.includes(player)) return;
    const nextUse = (n) => {
      for (let k = from; k < items.length; k++) if (playerOf(items[k], team) === n) return k;
      return Infinity;
    };
    const out = [...court].sort((a, b) => nextUse(b) - nextUse(a))[0];
    push({ type: 'sub', team, player, out }, quarter, 3000);
    courts[team] = court.map((n) => (n === out ? player : n));
  };

  SCRIPT.forEach((items, qi) => {
    const quarter = qi + 1;
    // クォーター間の休み（ハーフタイムは長め）
    ts = start + qi * 17 * 60000 + (quarter >= 3 ? 10 * 60000 : 0);
    push({ type: 'q_start' }, quarter);
    for (const [idx, it] of items.entries()) {
      const [kind] = it;
      ensureOnCourt(U, items, idx, quarter);
      ensureOnCourt(O, items, idx, quarter);
      switch (kind) {
        case 'df':
          if (it[1] === U) live.usDF = it[2];
          else live.oppDF = it[2];
          break;
        case 'fg': {
          const [, team, player, zone, made, tags = []] = it;
          const { x, y } = pointInZone(zone, rand);
          push({ type: 'fg', team, player, made, points: zone.startsWith('3P') ? 3 : 2, x, y, zone, tags }, quarter);
          break;
        }
        case 'ft':
          push({ type: 'ft', team: it[1], player: it[2], made: it[3], points: 1 }, quarter);
          break;
        case 'or':
          push({ type: 'oreb', team: it[1], player: it[2] }, quarter);
          break;
        case 'dr':
          push({ type: 'dreb', team: it[1], player: it[2] }, quarter);
          break;
        case 'to':
          push({ type: 'to', team: it[1], player: it[2], tags: it[3] || [] }, quarter);
          break;
        case 'ast':
        case 'stl':
        case 'blk':
          push({ type: kind, team: U, player: it[1] }, quarter);
          break;
        case 'foul':
          push({ type: 'foul', team: it[1], player: it[2] }, quarter);
          break;
        case 'timeout':
          push({ type: 'timeout', team: it[1], player: null }, quarter);
          break;
        case 'adjust':
          push({ type: 'adjust', team: it[1], player: null, made: true, points: it[2] }, quarter);
          break;
        default:
          throw new Error(`デモの種類が不明: ${kind}`);
      }
    }
    push({ type: 'q_end' }, quarter);
  });

  // 試合時計：各クォーター 10:00 から 0:00 まで、記録の順に均等に減らす
  for (let q = 1; q <= SCRIPT.length; q++) {
    const list = events.filter((e) => e.quarter === q && e.type !== 'lineup');
    const inner = list.filter((e) => e.type !== 'q_start' && e.type !== 'q_end');
    for (const e of list) {
      if (e.type === 'q_start') e.clock = 600;
      else if (e.type === 'q_end') e.clock = 0;
    }
    inner.forEach((e, k) => {
      e.clock = Math.round(600 * (1 - (k + 1) / (inner.length + 1)) * 10) / 10;
    });
  }

  game.live = { ...live };
  return { game, events };
}
