// 記録の共有（同期）の判断だけを集めた純粋関数。通信と保存は sync.js と db.js が受け持つ。
//
// しくみ：
//  ・端末で試合・記録・チームの設定を変えると、db.js が「送る予定」（outbox）に1件入れる（同じ記録は1件にまとまる）
//  ・同期では、送る予定のものを送り、そのあと共有から「前回の続き」（cursor）より新しいものを受け取る
//  ・受け取ったものは、端末に送る予定が残っている記録（端末で変えたばかり）には上書きしない
//  ・デモ試合は共有しない（端末の中だけ）

/** チームで共有する設定（端末ごとの設定・AI接続・ログイン・お気に入りは共有しない） */
export const SHARED_SETTING_KEYS = ['rosterTemplate', 'defenses', 'checklistTemplate', 'rewindSec', 'qaNotes', 'aiExclude'];

/** 1回に送る数の上限（Worker の MAX_PUSH と同じ） */
export const PUSH_CHUNK = 300;

export function teamSettingsOf(settings = {}) {
  const out = {};
  for (const k of SHARED_SETTING_KEYS) if (settings[k] !== undefined) out[k] = settings[k];
  return out;
}

/** 共有する設定が変わったか（並び順の違いだけなら変わっていない扱いにはしない。JSON で比べる） */
export function teamSettingsChanged(before = {}, after = {}) {
  return JSON.stringify(teamSettingsOf(before)) !== JSON.stringify(teamSettingsOf(after));
}

/** デモ試合（isDemo の印。古いデータは大会名でも見分ける） */
export function isDemoGame(game) {
  return !!game && (game.isDemo === true || game.tournament === 'デモ大会（架空）');
}

export const outboxKey = {
  game: (id) => `g:${id}`,
  event: (id) => `e:${id}`,
  team: () => 's:settings',
};

/**
 * 送る予定（outbox）と端末の記録から、Worker に送る形を作る。
 * entries：[{ key, kind: 'game'|'event'|'team', id, gameId, stamp }]
 * records：{ games: Map(id → 試合), events: Map(id → 記録), settings }
 * 戻り値 { push: { games, events, team }, sent: [送った entry]、skipped: [送らない entry（デモ）] }
 */
export function buildPush(entries, records, limit = PUSH_CHUNK) {
  const push = { games: [], events: [], team: null };
  const sent = [];
  const skipped = [];
  // 試合を先に（受け取った側が、記録より先に試合を知るように）
  const order = { game: 0, event: 1, team: 2 };
  const list = [...entries].sort((a, b) => order[a.kind] - order[b.kind] || a.stamp - b.stamp);
  for (const en of list) {
    if (en.kind === 'team') {
      if (push.team) continue;
      push.team = { data: JSON.stringify(teamSettingsOf(records.settings)), updatedAt: en.stamp };
      sent.push(en);
      continue;
    }
    if (en.kind === 'game') {
      if (push.games.length >= limit) continue;
      const g = records.games.get(en.id);
      if (g && isDemoGame(g)) {
        skipped.push(en);
        continue;
      }
      push.games.push(g
        ? { id: en.id, data: JSON.stringify(g), updatedAt: Math.max(g.updatedAt || 0, en.stamp) }
        : { id: en.id, data: '{}', updatedAt: en.stamp, deleted: true });
      sent.push(en);
      continue;
    }
    if (en.kind === 'event') {
      if (push.events.length >= limit) continue;
      const e = records.events.get(en.id);
      const gameId = e ? e.gameId : en.gameId;
      const g = gameId ? records.games.get(gameId) : null;
      if (!gameId || (g && isDemoGame(g))) {
        skipped.push(en);
        continue;
      }
      push.events.push(e
        ? { id: en.id, gameId, data: JSON.stringify(e), updatedAt: Math.max(e.updatedAt || e.ts || 0, en.stamp) }
        : { id: en.id, gameId, data: '{}', updatedAt: en.stamp, deleted: true });
      sent.push(en);
    }
  }
  return { push, sent, skipped };
}

function parse(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * 受け取ったものを、端末に反映する内容に分ける。
 * items：[{ t: 'g'|'e'|'s', id, gameId, data, deleted }]、pendingKeys：送る予定が残っている key の Set
 * 戻り値 { putGames, deleteGames, putEvents, deleteEvents, team, skipped }
 */
export function planApply(items, pendingKeys = new Set()) {
  const plan = { putGames: [], deleteGames: [], putEvents: [], deleteEvents: [], team: null, skipped: 0 };
  for (const it of items || []) {
    const key = it.t === 'g' ? outboxKey.game(it.id) : it.t === 'e' ? outboxKey.event(it.id) : outboxKey.team();
    if (pendingKeys.has(key)) {
      plan.skipped += 1;
      continue;
    }
    if (it.t === 'g') {
      if (it.deleted) plan.deleteGames.push(it.id);
      else {
        const g = parse(it.data);
        if (g && g.id === it.id) plan.putGames.push(g);
      }
    } else if (it.t === 'e') {
      if (it.deleted) plan.deleteEvents.push(it.id);
      else {
        const e = parse(it.data);
        if (e && e.id === it.id && e.gameId) plan.putEvents.push(e);
      }
    } else if (it.t === 's') {
      const s = parse(it.data);
      if (s) plan.team = teamSettingsOf(s);
    }
  }
  return plan;
}

/** 入力された Worker の URL から、もとの URL（末尾の /basket/insight を外したもの）を取り出す。正しくなければ null */
export function workerBase(url) {
  const s = String(url || '').trim().replace(/\/+$/, '').replace(/\/basket(\/insight)?$/, '');
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
  return s;
}

export const SYNC_ERROR_TEXT = {
  not_configured: 'Worker の URL が入っていません',
  bad_url: 'Worker の URL が正しくありません',
  offline: '電波がありません（つながったら自動で同期します）',
  network: '通信できません',
  timeout: '応答がありません',
  unauthorized: 'ログインが切れました。もう一度ログインしてください',
  forbidden: 'このアカウントではできません',
  db_not_configured: 'Worker にデータベース（D1）がつながっていません。worker/README.md の手順を見てください',
  wrong_login: 'ID かパスワードが違います',
  locked: 'まちがいが続いたので、15分ほどログインできません',
  invalid_input: '入力を確かめてください（ID は英小文字・数字・「. _ -」で3〜32字、パスワードは8字以上）',
  login_id_taken: 'その ID はもう使われています',
  already_set_up: '最初の管理者はもう作られています。ログインしてください',
  last_admin: '管理者が1人もいなくなるので、できません',
  cannot_delete_self: '自分のアカウントは消せません',
  origin_not_allowed: 'この URL からの接続が Worker で許可されていません',
  server_error: 'Worker でエラーが起きました',
  http: 'Worker でエラーが起きました',
};

export function syncErrorText(reason, status) {
  const base = SYNC_ERROR_TEXT[reason] || '通信できません';
  return reason === 'http' && status ? `${base}（${status}）` : base;
}

/**
 * 貼り付けた文から Worker の URL を取り出す（URL だけでも、「接続先」のメッセージをまるごと貼ってもよい）。なければ null。
 * URL はリポジトリに書かないので、ほかの端末へはメッセージで送って貼り付けてもらう。
 */
export function extractWorkerUrl(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const direct = workerBase(s);
  if (direct) return direct;
  const m = s.match(/https?:\/\/[^\s"'<>（）「」、。]+/);
  return m ? workerBase(m[0].replace(/[).,;:!?]+$/, '')) : null;
}

/** ほかの端末に送る「接続先」のメッセージ */
export function connectMessage(url) {
  const base = workerBase(url);
  if (!base) return '';
  return `BasketBall Analyst の接続先です。ログインの画面の「接続先」に、このメッセージをそのまま貼り付けてください。\n${base}`;
}

/** 「xxx.workers.dev」のような、接続先の見出し */
export function connectHost(url) {
  const base = workerBase(url);
  if (!base) return '';
  try {
    return new URL(base).host;
  } catch {
    return '';
  }
}

// ---- AI の結果を見られる人（管理者だけ） ----
// AI特筆データ・対処の例・AIふりかえり（と、ふりかえりで AI に伝えたメモ）は、試合後の講評で使うので管理者だけが見る。
// Worker も、管理者でないアカウントにはこれらを外して渡す（worker/sync.js の AI_GAME_KEYS と同じ）。

export const AI_GAME_KEYS = ['insights', 'advice', 'reports', 'reportNote'];

/** この端末で AI を使ったり結果を見たりできるか：ログインしていない端末（自分の端末）か、管理者でログイン */
export function canUseAi(settings = {}) {
  const loggedIn = !!(settings.authToken && settings.authUser && workerBase(settings.workerUrl));
  return !loggedIn || settings.authUser.role === 'admin';
}

/** 試合から AI の結果を外したもの（元の試合は変えない） */
export function stripAiFields(game) {
  if (!game || typeof game !== 'object') return game;
  const out = { ...game, insights: [], advice: [], reports: [] };
  delete out.reportNote;
  return out;
}

/** 試合に AI の結果が入っているか */
export function hasAiFields(game) {
  return !!game && ((game.insights || []).length > 0 || (game.advice || []).length > 0 || (game.reports || []).length > 0 || !!game.reportNote);
}
