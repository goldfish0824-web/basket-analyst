// 複数の画面で使う処理：ホーム画面追加の案内、バックアップ、デモ試合
import * as db from '../db.js';
import { h, toast, isStandalone, saveJsonFile, pickFile, readFileText, confirmDialog } from '../ui.js';
import { buildBackup, backupFileName, parseBackup } from '../backup.js';
import { generateDemo } from '../demo.js';

export function installHint(app, { compact = false } = {}) {
  if (isStandalone()) return null;
  if (compact && app.settings.installHintDismissed) return null;
  const close = async () => {
    await app.saveSettings({ ...app.settings, installHintDismissed: true });
    box.remove();
  };
  const box = h(
    'section',
    { class: 'notice install' },
    h('h2', null, 'ホーム画面に追加してください'),
    h('ol', null,
      h('li', null, 'Safari の共有ボタン（四角から上向きの矢印）をタップ'),
      h('li', null, '「ホーム画面に追加」を選ぶ'),
      h('li', null, 'ホーム画面のアイコンから開く')),
    h('p', null, 'ホーム画面に追加しないと、しばらく使わないうちに記録が消えることがあります。追加すると電波がなくても開けます。'),
    compact ? h('button', { class: 'btn small', type: 'button', onclick: close }, '閉じる') : null,
  );
  return box;
}

export function lastBackupText(ms) {
  if (!ms) return 'まだ書き出していません';
  const d = new Date(ms);
  return `前回：${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 端末内の全データ（試合・記録・設定）を JSON で書き出す */
export async function exportAll(app) {
  const [games, events] = await Promise.all([db.listGames(), db.listAllEvents()]);
  // 端末ごとの状態と、AI接続の URL・パスコードは書き出さない
  const { lastBackupAt, installHintDismissed, workerUrl, staffPass, ...settingsToSave } = app.settings;
  const data = buildBackup({ games, events, settings: settingsToSave });
  const ok = await saveJsonFile(data, backupFileName(games));
  if (ok) {
    await app.saveSettings({ ...app.settings, lastBackupAt: Date.now() });
    toast('バックアップを書き出しました');
  }
  return ok;
}

export async function exportGame(game) {
  const events = await db.listEvents(game.id);
  const ok = await saveJsonFile(buildBackup({ games: [game], events }), backupFileName([game]));
  if (ok) toast('この試合を書き出しました');
  return ok;
}

/** JSON を読み込む。同じ ID の試合は上書きする。全データのバックアップなら設定も戻す。 */
export async function importBackup(app) {
  const file = await pickFile();
  if (!file) return false;
  let parsed;
  try {
    parsed = parseBackup(await readFileText(file));
  } catch (err) {
    toast(err.message, { kind: 'error', ms: 4000 });
    return false;
  }
  const existing = new Set((await db.listGames()).map((g) => g.id));
  const overwrite = parsed.games.filter((g) => existing.has(g.id)).length;
  const lines = [`${parsed.games.length}試合（${parsed.events.length}件の記録）を読み込みます。`];
  if (overwrite) lines.push(`端末にある同じ試合 ${overwrite}件は、ファイルの内容で上書きします。`);
  if (parsed.settings) lines.push('名簿テンプレートと守備隊形の選択肢も、ファイルの内容に置き換えます。');
  if (parsed.skipped) lines.push(`形の合わない記録 ${parsed.skipped}件は読み飛ばします。`);
  const ok = await confirmDialog(lines.join('\n'), { ok: '読み込む', title: 'バックアップの読み込み' });
  if (!ok) return false;
  await db.replaceGames(parsed.games, parsed.events);
  if (parsed.settings) {
    const next = { ...app.settings };
    if (Array.isArray(parsed.settings.rosterTemplate)) next.rosterTemplate = parsed.settings.rosterTemplate;
    if (Array.isArray(parsed.settings.defenses) && parsed.settings.defenses.length) next.defenses = parsed.settings.defenses;
    await app.saveSettings(next);
  }
  toast(`${parsed.games.length}試合を読み込みました`);
  return true;
}

/** デモ試合（架空の名前、約120イベント）を作って保存する */
export async function createDemoGame(app) {
  const { game, events } = generateDemo({ seed: Math.floor(Math.random() * 1e9), defenses: app.settings.defenses });
  await db.replaceGames([game], events);
  return game;
}

/** 名簿の行（背番号・呼び名・削除）を編集する部品。getRows() で今の値を返す。 */
export function rosterEditor(initial) {
  const body = h('div', { class: 'roster-rows' });
  const addRow = (p = { number: '', name: '' }) => {
    const row = h('div', { class: 'roster-row' },
      h('input', { class: 'num', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '2', placeholder: '背番号', value: p.number, 'aria-label': '背番号' }),
      h('input', { class: 'name', type: 'text', maxlength: '12', placeholder: '呼び名', value: p.name, 'aria-label': '呼び名' }),
      h('button', { class: 'btn small', type: 'button', 'aria-label': 'この選手を外す', onclick: () => row.remove() }, '外す'));
    body.appendChild(row);
    return row;
  };
  for (const p of initial) addRow(p);
  const el = h('div', { class: 'roster-editor' },
    h('div', { class: 'roster-head' }, h('span', null, '背番号'), h('span', null, '呼び名'), h('span', null, '')),
    body,
    h('button', {
      class: 'btn', type: 'button',
      onclick: () => {
        const r = addRow();
        r.querySelector('input').focus();
      },
    }, '＋ 選手を追加'));
  return {
    el,
    setRows(rows) {
      body.textContent = '';
      for (const p of rows) addRow(p);
    },
    /** 空行は除く。背番号の重複や数字以外はエラー文を返す */
    read() {
      const rows = [];
      const seen = new Set();
      for (const row of body.querySelectorAll('.roster-row')) {
        const number = row.querySelector('.num').value.trim();
        const name = row.querySelector('.name').value.trim();
        if (!number && !name) continue;
        if (!/^\d{1,2}$/.test(number)) return { error: `背番号は0〜99の数字で入力してください（${name || number}）` };
        if (seen.has(number)) return { error: `背番号 ${number} が重複しています` };
        seen.add(number);
        rows.push({ number, name });
      }
      return { rows };
    },
  };
}
