// 試合設定：日付、大会名、相手校名、自チームの出場メンバー、相手の背番号、YouTube URL
import * as db from '../db.js';
import { h, toast, todayString, icon } from '../ui.js';
import { newGame, sortNumbers, parseNumberList } from '../model.js';
import { rosterEditor } from './shared.js';
import { videoEditor } from './video-editor.js';

export async function renderSetup(root, params, app) {
  const editing = params.gameId ? await db.getGame(params.gameId) : null;
  if (params.gameId && !editing) {
    toast('試合が見つかりません', { kind: 'error' });
    app.go('#/');
    return;
  }
  const g = editing || {
    date: todayString(),
    tournament: '',
    opponent: '',
    roster: app.settings.rosterTemplate,
    oppNumbers: [],
    videos: [],
  };

  const date = h('input', { type: 'date', value: g.date || todayString(), required: true });
  const tournament = h('input', { type: 'text', value: g.tournament || '', placeholder: '例：新人戦 地区予選', maxlength: '40' });
  const opponent = h('input', { type: 'text', value: g.opponent || '', placeholder: '例：○○高校', maxlength: '30' });
  const roster = rosterEditor(g.roster && g.roster.length ? g.roster : [{ number: '', name: '' }]);
  const oppNums = h('input', {
    type: 'text', inputmode: 'numeric', value: (g.oppNumbers || []).join(' '),
    placeholder: '例：4 5 6 7 8（分からなければ空欄。試合中にも追加できます）',
  });
  const video = videoEditor(g.videos || []);
  const errorBox = h('p', { class: 'form-error', role: 'alert' });

  const save = async () => {
    errorBox.textContent = '';
    const r = roster.read();
    if (r.error) {
      errorBox.textContent = r.error;
      return;
    }
    if (r.rows.length === 0) {
      errorBox.textContent = '自チームの選手を1人以上入力してください';
      return;
    }
    const opp = parseNumberList(oppNums.value);
    if (opp.bad.length) {
      errorBox.textContent = `相手の背番号は0〜99の数字で入力してください（${opp.bad.join('、')}）`;
      return;
    }
    const v = video.read();
    if (v.error) {
      errorBox.textContent = v.error;
      return;
    }
    const { videos } = v;
    let game;
    if (editing) {
      game = {
        ...editing,
        date: date.value,
        tournament: tournament.value.trim(),
        opponent: opponent.value.trim(),
        roster: r.rows,
        oppNumbers: sortNumbers(opp.numbers),
        videos,
      };
    } else {
      game = newGame({
        date: date.value || todayString(),
        tournament: tournament.value.trim(),
        opponent: opponent.value.trim(),
        roster: r.rows,
        oppNumbers: opp.numbers,
        videos,
        defenses: app.settings.defenses,
      });
    }
    await db.putGame(game);
    toast(editing ? '保存しました' : '試合を作りました');
    app.go(`#/game/${game.id}/record`);
  };

  const field = (label, input, note) =>
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, note ? h('span', { class: 'field-note' }, note) : null);

  root.append(
    h('header', { class: 'page-head' },
      h('a', { class: 'btn', href: editing ? `#/game/${editing.id}/record` : '#/' }, icon('back'), '戻る'),
      h('h1', null, editing ? '試合設定' : '新しい試合'),
      h('div', { class: 'head-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: save }, editing ? '保存' : '保存して記録へ'))),
    h('div', { class: 'page form' },
      h('div', { class: 'grid-2' },
        field('日付', date),
        field('大会名', tournament),
        field('相手校名', opponent)),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h2', null, '自チームの出場メンバー'),
          h('button', {
            class: 'btn small', type: 'button',
            onclick: () => {
              if (!app.settings.rosterTemplate.length) {
                toast('設定に名簿テンプレートがありません');
                return;
              }
              roster.setRows(app.settings.rosterTemplate);
              toast('名簿テンプレートを読み込みました');
            },
          }, 'テンプレートから読み込む'),
          h('button', {
            class: 'btn small', type: 'button',
            onclick: async () => {
              const r = roster.read();
              if (r.error) {
                errorBox.textContent = r.error;
                return;
              }
              await app.saveSettings({ ...app.settings, rosterTemplate: r.rows });
              toast('この名簿をテンプレートに保存しました');
            },
          }, 'この名簿をテンプレートに保存')),
        roster.el),
      h('section', { class: 'card' },
        h('h2', null, '相手の背番号'),
        oppNums,
        h('p', { class: 'field-note' }, 'スペースか「、」で区切ります。記録画面の「＋番号」でも追加できます。')),
      h('section', { class: 'card' },
        h('h2', null, 'YouTube（後から入力できます）'),
        video.el),
      errorBox,
      h('div', { class: 'form-actions' }, h('button', { class: 'btn primary big', type: 'button', onclick: save }, editing ? '保存' : '保存して記録へ'))),
  );
}
