// ホーム：試合一覧（新しい順）、新規試合、設定、バックアップ
import * as db from '../db.js';
import { h, modal, confirmDialog, toast, formatDate } from '../ui.js';
import { sortGames, quarterState, quarterLabel } from '../model.js';
import { scoreOf } from '../stats.js';
import { installHint, exportAll, exportGame, createDemoGame, lastBackupText } from './shared.js';

export async function renderHome(root, params, app) {
  const games = sortGames(await db.listGames());
  const scores = new Map();
  await Promise.all(
    games.map(async (g) => {
      const ev = await db.listEvents(g.id);
      scores.set(g.id, { score: scoreOf(ev), qs: quarterState(ev), count: ev.length });
    }),
  );

  const backupStatus = h('span', { class: 'muted' }, lastBackupText(app.settings.lastBackupAt));

  const list = games.length
    ? h('ul', { class: 'game-list' }, games.map((g) => gameCard(g, scores.get(g.id), app)))
    : h('div', { class: 'empty' },
        h('p', null, 'まだ試合がありません。'),
        h('p', null, '「新しい試合」から始めるか、デモ試合で集計とシュートチャートを確かめられます。'),
        h('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            const g = await createDemoGame(app);
            toast('デモ試合を作りました');
            app.go(`#/game/${g.id}/summary`);
          },
        }, 'デモ試合を作る'));

  root.append(
    h('header', { class: 'page-head' },
      h('h1', null, 'バスケ・アナリスト'),
      h('div', { class: 'head-actions' },
        h('a', { class: 'btn', href: '#/settings' }, '設定'),
        h('a', { class: 'btn primary', href: '#/new' }, '＋ 新しい試合'))),
    h('div', { class: 'page' },
      installHint(app, { compact: true }),
      h('section', { class: 'backup-bar' },
        h('div', null, h('strong', null, 'バックアップ'), ' ', backupStatus),
        h('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            if (await exportAll(app)) backupStatus.textContent = lastBackupText(app.settings.lastBackupAt);
          },
        }, 'すべて書き出す')),
      h('h2', { class: 'section-title' }, '試合一覧'),
      list),
  );
}

function statusText(info) {
  if (!info || info.count === 0) return '記録なし';
  const { qs } = info;
  if (qs.phase === 'pre') return '試合前';
  if (qs.phase === 'live') return `${quarterLabel(qs.quarter)} 記録中`;
  return `${quarterLabel(qs.quarter)} 終了`;
}

function gameCard(g, info, app) {
  const score = info ? info.score : { us: 0, opp: 0 };
  const more = () => {
    const close = modal({
      title: `${formatDate(g.date)} ${g.opponent || '相手未入力'}`,
      body: h('div', { class: 'menu-list' },
        h('a', { class: 'btn', href: `#/game/${g.id}/edit`, onclick: () => close() }, '試合設定を編集'),
        h('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            close();
            await exportGame(g);
          },
        }, 'この試合を書き出す'),
        h('button', {
          class: 'btn danger', type: 'button',
          onclick: async () => {
            close();
            const ok = await confirmDialog(`${formatDate(g.date)} ${g.opponent} の試合を削除します。記録もすべて消えます。`, {
              ok: '削除する', danger: true, title: '試合の削除',
            });
            if (!ok) return;
            await db.deleteGame(g.id);
            toast('削除しました');
            app.go('#/');
          },
        }, 'この試合を削除')),
      actions: [{ label: '閉じる' }],
    });
  };
  return h('li', { class: 'game-card' },
    h('a', { class: 'game-main', href: `#/game/${g.id}/record` },
      h('div', { class: 'game-date' }, formatDate(g.date), g.isDemo ? h('span', { class: 'tag' }, 'デモ') : null),
      h('div', { class: 'game-title' }, `vs ${g.opponent || '相手未入力'}`),
      h('div', { class: 'game-sub' }, g.tournament || '', ' ', h('span', { class: 'muted' }, statusText(info)))),
    h('div', { class: 'game-score' },
      h('span', { class: 'us' }, score.us), h('span', { class: 'sep' }, '−'), h('span', { class: 'opp' }, score.opp)),
    h('div', { class: 'game-actions' },
      h('a', { class: 'btn', href: `#/game/${g.id}/record` }, '記録'),
      h('a', { class: 'btn', href: `#/game/${g.id}/summary` }, '集計'),
      h('a', { class: 'btn', href: `#/game/${g.id}/review` }, '振り返り'),
      h('button', { class: 'btn', type: 'button', 'aria-label': 'その他の操作', onclick: more }, '…')),
  );
}
