// 設定：バックアップ、ホーム画面追加の案内、名簿テンプレート、守備隊形の選択肢、AI接続、デモ試合
import { h, toast, confirmDialog, isStandalone } from '../ui.js';
import { DEFAULT_DEFENSES } from '../model.js';
import { insightEndpoint, testConnection, reasonText } from '../ai.js';
import {
  installHint, exportAll, importBackup, createDemoGame, rosterEditor, lastBackupText,
} from './shared.js';

export async function renderSettings(root, params, app) {
  const backupStatus = h('span', { class: 'muted' }, lastBackupText(app.settings.lastBackupAt));

  // ---- 名簿テンプレート ----
  const roster = rosterEditor(app.settings.rosterTemplate.length ? app.settings.rosterTemplate : [{ number: '', name: '' }]);
  const rosterError = h('p', { class: 'form-error', role: 'alert' });

  // ---- 守備隊形の選択肢 ----
  let defenses = [...app.settings.defenses];
  const defList = h('ul', { class: 'def-list' });
  const defInput = h('input', { type: 'text', placeholder: '例：1-1-3ゾーン', maxlength: '20', 'aria-label': '追加する守備隊形' });
  const saveDefenses = async (next) => {
    defenses = next;
    await app.saveSettings({ ...app.settings, defenses: next });
    drawDefenses();
  };
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= defenses.length) return;
    const next = [...defenses];
    [next[i], next[j]] = [next[j], next[i]];
    saveDefenses(next);
  };
  function drawDefenses() {
    defList.textContent = '';
    defenses.forEach((d, i) => {
      defList.appendChild(h('li', { class: 'def-item' },
        h('span', { class: 'def-name' }, d),
        h('button', { class: 'btn small', type: 'button', 'aria-label': `${d}を上へ`, disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
        h('button', { class: 'btn small', type: 'button', 'aria-label': `${d}を下へ`, disabled: i === defenses.length - 1, onclick: () => move(i, 1) }, '↓'),
        h('button', {
          class: 'btn small', type: 'button', 'aria-label': `${d}を削除`, disabled: defenses.length <= 1,
          onclick: () => saveDefenses(defenses.filter((_, k) => k !== i)),
        }, '削除')));
    });
  }
  drawDefenses();

  // ---- AI接続 ----
  const workerUrl = h('input', {
    type: 'url', inputmode: 'url', value: app.settings.workerUrl || '', placeholder: 'https://（中継 Worker の URL）',
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Worker の URL',
  });
  const staffPass = h('input', {
    type: 'password', value: app.settings.staffPass || '', placeholder: 'スタッフ用パスコード',
    autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'スタッフ用パスコード',
  });
  const aiStatus = h('p', { class: 'ai-conn-status', 'aria-live': 'polite' });
  const readAi = () => {
    const url = workerUrl.value.trim();
    if (url && !insightEndpoint(url)) {
      aiStatus.textContent = 'URL は https:// から始まる形で入力してください';
      aiStatus.className = 'ai-conn-status error';
      return null;
    }
    return { workerUrl: url, staffPass: staffPass.value };
  };
  const saveAi = async () => {
    const v = readAi();
    if (!v) return null;
    await app.saveSettings({ ...app.settings, ...v });
    return v;
  };

  root.append(
    h('header', { class: 'page-head' },
      h('a', { class: 'btn', href: '#/' }, 'ホーム'),
      h('h1', null, '設定'),
      h('div', { class: 'head-actions' })),
    h('div', { class: 'page form' },
      h('section', { class: 'card emphasis' },
        h('h2', null, 'バックアップ'),
        h('p', null, '記録はこの iPad の中だけに保存されています。試合のあとは「すべて書き出す」でファイルに保存してください（「ファイル」アプリやAirDropに送れます）。'),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn primary big', type: 'button',
            onclick: async () => {
              if (await exportAll(app)) backupStatus.textContent = lastBackupText(app.settings.lastBackupAt);
            },
          }, 'バックアップを書き出す'),
          h('button', {
            class: 'btn big', type: 'button',
            onclick: async () => {
              if (await importBackup(app)) app.go('#/');
            },
          }, 'バックアップを読み込む'),
          backupStatus)),
      isStandalone()
        ? h('section', { class: 'card' }, h('h2', null, 'ホーム画面から起動しています'), h('p', null, '電波がなくても記録・集計できます。'))
        : installHint(app),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '自チームの名簿テンプレート')),
        h('p', { class: 'field-note' }, '新しい試合を作るときに、この名簿が出場メンバーに入ります。呼び名は端末の中だけで使い、AIには送りません。'),
        roster.el,
        rosterError,
        h('div', { class: 'row' }, h('button', {
          class: 'btn primary', type: 'button',
          onclick: async () => {
            rosterError.textContent = '';
            const r = roster.read();
            if (r.error) {
              rosterError.textContent = r.error;
              return;
            }
            await app.saveSettings({ ...app.settings, rosterTemplate: r.rows });
            toast('名簿テンプレートを保存しました');
          },
        }, '名簿を保存'))),
      h('section', { class: 'card' },
        h('h2', null, '守備隊形の選択肢'),
        h('p', { class: 'field-note' }, '記録画面の「自DF」「相手DF」で選ぶ項目です。いちばん上が新しい試合の初期値になります。'),
        defList,
        h('div', { class: 'row' },
          defInput,
          h('button', {
            class: 'btn', type: 'button',
            onclick: () => {
              const v = defInput.value.trim();
              if (!v) return;
              if (defenses.includes(v)) {
                toast('同じ名前があります');
                return;
              }
              defInput.value = '';
              saveDefenses([...defenses, v]);
            },
          }, '追加'),
          h('button', {
            class: 'btn', type: 'button',
            onclick: async () => {
              if (await confirmDialog('守備隊形の選択肢を最初の状態に戻します。', { ok: '戻す' })) saveDefenses([...DEFAULT_DEFENSES]);
            },
          }, '初期値に戻す'))),
      h('section', { class: 'card' },
        h('h2', null, 'AI接続（AI特筆データ）'),
        h('p', { class: 'field-note' }, 'クォーター終了画面の「AI特筆データ」で使います。未設定・通信できないときは、端末内の自動抽出（AIなし）で表示します。'),
        h('div', { class: 'grid-2' },
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Worker の URL'), workerUrl),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'スタッフ用パスコード'), staffPass)),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn primary', type: 'button',
            onclick: async () => {
              if (await saveAi()) {
                aiStatus.textContent = '保存しました';
                aiStatus.className = 'ai-conn-status';
              }
            },
          }, '保存'),
          h('button', {
            class: 'btn', type: 'button',
            onclick: async () => {
              const v = await saveAi();
              if (!v) return;
              aiStatus.textContent = '接続を確かめています…';
              aiStatus.className = 'ai-conn-status';
              const r = await testConnection(v, { online: navigator.onLine !== false });
              aiStatus.textContent = r.ok ? '接続できました' : `接続できません：${reasonText(r)}`;
              aiStatus.className = `ai-conn-status ${r.ok ? 'ok' : 'error'}`;
            },
          }, '接続テスト')),
        aiStatus,
        h('p', { class: 'field-note' }, 'URL とパスコードはこの端末の中だけに保存します（バックアップのファイルにも入れません）。Worker の用意は worker/README.md を見てください。')),
      h('section', { class: 'card' },
        h('h2', null, 'デモ試合'),
        h('p', null, '架空の名前で約120件の記録が入った試合を作ります。集計・シュートチャートの確認に使えます。'),
        h('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            const g = await createDemoGame(app);
            toast('デモ試合を作りました');
            app.go(`#/game/${g.id}/summary`);
          },
        }, 'デモ試合を作る')),
      h('p', { class: 'muted small' }, 'バスケ・アナリスト v0.1')),
  );
}
