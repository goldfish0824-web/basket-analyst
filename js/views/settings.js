// 設定：バックアップ、ホーム画面追加の案内、名簿テンプレート、守備隊形の選択肢、チェック項目、振り返り、AI接続、デモ試合
import { getVersion, checkNow } from '../update.js';
import { h, toast, confirmDialog, isStandalone, icon, applyTheme } from '../ui.js';
import { DEFAULT_DEFENSES, uuid } from '../model.js';
import { insightEndpoint, testConnection, reasonText } from '../ai.js';
import { CHECK_METRICS, CHECK_EXAMPLES, DEFAULT_REWIND_SEC, targetText, parseBulkItems } from '../review.js';
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

  // ---- チェック項目のテンプレート・巻き戻し秒数 ----
  const checklist = checklistEditor(app.settings.checklistTemplate || []);
  const checkError = h('p', { class: 'form-error', role: 'alert' });
  const rewind = h('input', {
    type: 'number', inputmode: 'numeric', min: '0', max: '60', step: '1', class: 'rewind-input',
    value: String(app.settings.rewindSec ?? DEFAULT_REWIND_SEC), 'aria-label': '巻き戻し秒数',
  });

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
      h('a', { class: 'btn', href: '#/' }, icon('home'), 'ホーム'),
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
          }, icon('share'), 'バックアップを書き出す'),
          h('button', {
            class: 'btn big', type: 'button',
            onclick: async () => {
              if (await importBackup(app)) app.go('#/');
            },
          }, icon('download'), 'バックアップを読み込む'),
          backupStatus)),
      themeCard(app),
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
        h('h2', null, 'チェック項目（振り返りのチェックポイント）'),
        h('p', { class: 'field-note' }, '項目は自由に追加・編集・並べ替えできます。「対象」にチェックを入れた項目だけが、振り返り画面のチェックポイントに出ます（評価済みの試合は、評価したときの項目のまま）。数字と結びつけられる項目は目標を入れると、試合の数字から自動で ◯／× を出します。'),
        checklist.el,
        checkError,
        h('div', { class: 'row' },
          h('button', {
            class: 'btn primary', type: 'button',
            onclick: async () => {
              checkError.textContent = '';
              const r = checklist.read();
              if (r.error) {
                checkError.textContent = r.error;
                return;
              }
              await app.saveSettings({ ...app.settings, checklistTemplate: r.items });
              checklist.setItems(r.items);
              toast('チェック項目を保存しました');
            },
          }, 'チェック項目を保存'),
          h('button', {
            class: 'btn', type: 'button',
            onclick: () => {
              checklist.addExamples();
              toast('例を追加しました（保存するまで反映されません）');
            },
          }, '例を入れる'))),
      h('section', { class: 'card' },
        h('h2', null, '振り返り（動画）'),
        h('label', { class: 'field inline' },
          h('span', { class: 'field-label' }, '巻き戻し秒数'),
          rewind,
          h('span', null, '秒')),
        h('p', { class: 'field-note' }, '記録はプレーの後に入力するので、動画はその分だけ前から再生します（既定 8秒）。'),
        h('div', { class: 'row' }, h('button', {
          class: 'btn primary', type: 'button',
          onclick: async () => {
            const v = Number(rewind.value);
            if (!Number.isFinite(v) || v < 0 || v > 60) {
              toast('巻き戻し秒数は 0〜60 で入れてください', { kind: 'error' });
              return;
            }
            await app.saveSettings({ ...app.settings, rewindSec: Math.round(v) });
            toast('保存しました');
          },
        }, '保存'))),
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
      updateCard(),
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
      h('p', { class: 'muted small' }, 'BasketBall Analyst')),
  );
}

/**
 * チェック項目のテンプレートを編集する部品。
 * 項目は多くてもよい（50程度）。「対象」に入れた項目だけが振り返り画面のチェックポイントに出る。
 */
function checklistEditor(initial) {
  const rows = h('div', { class: 'check-rows' });
  const countEl = h('span', { class: 'ck-count' });
  const dirtyEl = h('span', { class: 'ck-dirty', 'aria-live': 'polite' });
  const onlyActive = h('input', { type: 'checkbox', onchange: () => applyFilter() });
  const bulkText = h('textarea', { class: 'ck-bulk', rows: '6', placeholder: '例：\nボックスアウト\nヘルプの位置\nトランジションで3線を走る', 'aria-label': 'まとめて追加する項目（1行に1項目）' });
  const bulkStatus = h('span', { class: 'muted' });

  const markDirty = () => {
    dirtyEl.textContent = '保存していない変更があります';
  };
  const updateCount = () => {
    const all = rows.querySelectorAll('.check-row');
    const on = [...all].filter((r) => r.querySelector('.ck-active').checked).length;
    countEl.textContent = `対象 ${on}／全 ${all.length}項目`;
  };
  const applyFilter = () => {
    for (const r of rows.querySelectorAll('.check-row')) {
      r.hidden = onlyActive.checked && !r.querySelector('.ck-active').checked;
    }
  };
  const changed = () => {
    markDirty();
    updateCount();
    applyFilter();
  };

  const addRow = (item = { id: uuid(), label: '', target: null, active: true }) => {
    const active = h('input', { type: 'checkbox', class: 'ck-active', checked: item.active !== false, 'aria-label': '対象にする' });
    const label = h('input', { type: 'text', class: 'ck-label', value: item.label || '', placeholder: '例：ボックスアウト', maxlength: '40', 'aria-label': '項目名' });
    const metric = h('select', { class: 'ck-metric', 'aria-label': '目標にする数字' },
      h('option', { value: '' }, '目標なし（◯△×で評価）'),
      CHECK_METRICS.map((m) => h('option', { value: m.key, selected: item.target && item.target.key === m.key }, m.label)));
    const value = h('input', {
      type: 'number', inputmode: 'decimal', class: 'ck-value', value: item.target ? String(item.target.value) : '', placeholder: '数', 'aria-label': '目標の数',
    });
    const op = h('select', { class: 'ck-op', 'aria-label': '以下か以上か' },
      h('option', { value: 'le', selected: !item.target || item.target.op !== 'ge' }, '以下'),
      h('option', { value: 'ge', selected: item.target && item.target.op === 'ge' }, '以上'));
    const targetBox = h('span', { class: 'ck-target' }, value, op);
    const row = h('div', { class: 'check-row', dataset: { id: item.id } },
      h('label', { class: 'ck-active-wrap', title: '対象にする' }, active),
      label, metric, targetBox,
      h('button', { class: 'btn small', type: 'button', 'aria-label': '上へ', onclick: () => { if (row.previousElementSibling) { rows.insertBefore(row, row.previousElementSibling); markDirty(); } } }, '↑'),
      h('button', { class: 'btn small', type: 'button', 'aria-label': '下へ', onclick: () => { if (row.nextElementSibling) { rows.insertBefore(row.nextElementSibling, row); markDirty(); } } }, '↓'),
      h('button', { class: 'btn small', type: 'button', 'aria-label': 'この項目を削除', onclick: () => { row.remove(); changed(); } }, '削除'));
    const sync = () => {
      targetBox.style.visibility = metric.value ? 'visible' : 'hidden';
      row.classList.toggle('inactive', !active.checked);
    };
    metric.addEventListener('change', sync);
    active.addEventListener('change', () => {
      sync();
      changed();
    });
    sync();
    rows.appendChild(row);
    return row;
  };

  const setAll = (on) => {
    for (const r of rows.querySelectorAll('.check-row')) {
      const cb = r.querySelector('.ck-active');
      cb.checked = on;
      r.classList.toggle('inactive', !on);
    }
    changed();
  };

  const currentLabels = () => [...rows.querySelectorAll('.ck-label')].map((i) => i.value.trim()).filter(Boolean);

  for (const it of initial) addRow(it);
  updateCount();

  // 入力したら「保存していない変更」を出す
  rows.addEventListener('input', markDirty);

  const el = h('div', { class: 'checklist-editor' },
    h('div', { class: 'ck-toolbar' },
      countEl,
      h('button', { class: 'btn small', type: 'button', onclick: () => setAll(true) }, 'すべて対象にする'),
      h('button', { class: 'btn small', type: 'button', onclick: () => setAll(false) }, 'すべて対象から外す'),
      h('label', { class: 'check' }, onlyActive, '対象だけ表示')),
    h('div', { class: 'ck-head' }, h('span', null, '対象'), h('span', null, '項目名と目標（目標は数字と結びつける項目だけ）')),
    rows,
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => { onlyActive.checked = false; applyFilter(); addRow().querySelector('.ck-label').focus(); changed(); } }, '＋ 項目を追加')),
    h('details', { class: 'ck-bulk-box' },
      h('summary', null, 'まとめて追加（1行に1項目）'),
      h('p', { class: 'field-note' }, 'コーチと決めた項目の一覧をコピーして貼り付けられます。行頭の「・」「1.」などは外します。同じ名前の項目は追加しません。'),
      bulkText,
      h('div', { class: 'row' },
        h('button', {
          class: 'btn', type: 'button',
          onclick: () => {
            const r = parseBulkItems(bulkText.value, currentLabels());
            for (const label of r.labels) addRow({ id: uuid(), label, target: null, active: true });
            bulkText.value = '';
            bulkStatus.textContent = `${r.labels.length}件追加しました${r.skipped ? `（同じ名前の ${r.skipped}件は飛ばしました）` : ''}。「チェック項目を保存」で保存します。`;
            changed();
          },
        }, '追加'),
        bulkStatus)),
    dirtyEl);

  return {
    el,
    setItems(items) {
      rows.textContent = '';
      for (const it of items) addRow(it);
      dirtyEl.textContent = '';
      updateCount();
      applyFilter();
    },
    addExamples() {
      for (const ex of CHECK_EXAMPLES) addRow({ id: uuid(), label: ex.label, target: ex.target ? { ...ex.target } : null, active: true });
      changed();
    },
    read() {
      const items = [];
      for (const row of rows.querySelectorAll('.check-row')) {
        const label = row.querySelector('.ck-label').value.trim();
        const key = row.querySelector('.ck-metric').value;
        const valueText = row.querySelector('.ck-value').value.trim();
        if (!label && !key) continue;
        let target = null;
        if (key) {
          const value = Number(valueText);
          if (valueText === '' || !Number.isFinite(value)) return { error: `目標の数を入れてください（${label || '名前なし'}）` };
          target = { key, op: row.querySelector('.ck-op').value, value };
        }
        items.push({ id: row.dataset.id, label: label || targetText(target), target, active: row.querySelector('.ck-active').checked });
      }
      return { items };
    },
  };
}

/** 画面の配色（ダーク／ライト） */
function themeCard(app) {
  const current = () => (app.settings.theme === 'light' ? 'light' : 'dark');
  const choice = h('div', { class: 'theme-choice', role: 'group', 'aria-label': '画面の配色' });
  const draw = () => {
    choice.textContent = '';
    for (const [value, label] of [['dark', 'ダーク（標準）'], ['light', 'ライト']]) {
      choice.appendChild(h('button', {
        class: ['btn', current() === value && 'on'], type: 'button', 'aria-pressed': String(current() === value),
        onclick: async () => {
          await app.saveSettings({ ...app.settings, theme: value });
          draw();
        },
      }, label));
    }
  };
  draw();
  return h('section', { class: 'card' },
    h('h2', null, '画面の配色'),
    choice,
    h('p', { class: 'field-note' }, '明るい体育館で画面が見にくいときはライトにしてください。この iPad だけの設定です。'));
}

/** アプリの版と「最新の版を確かめる」 */
function updateCard() {
  const versionEl = h('span', null, '確かめています…');
  getVersion().then((v) => {
    versionEl.textContent = v ? `今の版：${v}` : '今の版：—（ブラウザで開いているときは、開くたびに最新になります）';
  });
  const status = h('p', { class: 'field-note', 'aria-live': 'polite' });
  const btn = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      btn.disabled = true;
      status.textContent = '確かめています…';
      const r = await checkNow();
      if (r === 'updated') {
        status.textContent = '新しい版になりました。読み込み直します…';
        setTimeout(() => location.reload(), 600);
        return;
      }
      status.textContent = r === 'latest' ? '最新の版です。' : 'この開き方では確かめられません。';
      btn.disabled = false;
    },
  }, '最新の版を確かめる');
  return h('section', { class: 'card' },
    h('h2', null, 'アプリの版'),
    h('p', null, versionEl),
    h('div', { class: 'row' }, btn),
    status,
    h('p', { class: 'field-note' }, 'ホーム画面から開いたアプリも、前面に出したときに新しい版を自動で確かめます。新しい版になると、画面の下に「更新する」が出ます（ホーム画面ではそのまま読み込み直します）。記録は消えません。'));
}

