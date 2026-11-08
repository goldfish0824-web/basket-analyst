// 設定画面の「記録の共有（ログイン）」：ログイン・最初の管理者・同期の状態・パスワード・スタッフのアカウント
import { h, replace, toast, confirmDialog, icon } from '../ui.js';
import {
  login, setupAdmin, logout, syncNow, onSyncStatus, statusText, isLoggedIn, errorText,
  changePassword, listUsers, createUser, updateUser, deleteUser,
} from '../sync.js';
import { workerBase, extractWorkerUrl, connectMessage, connectHost } from '../sync-core.js';

const ROLE_LABEL = { admin: '管理者', staff: 'スタッフ', student: '部員（見るだけ）' };

function input(attrs) {
  return h('input', { autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...attrs });
}

function field(label, el, note) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), el, note ? h('span', { class: 'field-note' }, note) : null);
}

/** 返り値：設定画面に置く card。cleanup は画面を離れるときに呼ぶ */
export function accountCard(app) {
  const card = h('section', { class: 'card account-card' });
  let unsubscribe = null;

  function draw() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    replace(card, ...(isLoggedIn(app.settings) ? loggedInView() : loggedOutView()));
  }

  // ---- ログインしていないとき ----
  function loggedOutView() {
    const url = input({ type: 'text', inputmode: 'url', value: app.settings.workerUrl || '', placeholder: 'https:// から始まる URL（送ってもらった文をそのまま貼り付けてもよい）', 'aria-label': '共有の Worker の URL' });
    // この端末に接続先が保存してあれば、ID とパスワードだけでログインする（接続先の欄は「変える」で出す）
    const known = workerBase(app.settings.workerUrl);
    let editing = !known;
    const urlBox = h('div', { class: 'connect-box' });
    const drawUrl = () => {
      replace(urlBox, editing
        ? field('接続先（Worker の URL）', url, '初めての端末だけ入れます。ログインしている端末の「ほかの端末でログインするとき」から送ったメッセージを、そのまま貼り付けてもかまいません。')
        : h('div', { class: 'connect-known' },
          h('span', null, icon('check'), `接続先：${connectHost(known)}（この端末に保存ずみ）`),
          h('button', { class: 'btn small', type: 'button', onclick: () => { editing = true; drawUrl(); url.focus(); } }, '変える')));
    };
    drawUrl();
    const id = input({ type: 'text', placeholder: '例：yamada', 'aria-label': 'ログイン ID' });
    const pw = input({ type: 'password', placeholder: 'パスワード', 'aria-label': 'パスワード' });
    const status = h('p', { class: 'ai-conn-status', 'aria-live': 'polite' });
    const say = (text, kind = '') => {
      status.textContent = text;
      status.className = `ai-conn-status ${kind}`;
    };
    const saveUrl = async () => {
      const v = editing ? extractWorkerUrl(url.value) : known;
      if (!v) {
        say('接続先（Worker の URL）を入れてください。https:// から始まる URL か、送ってもらったメッセージを貼り付けます', 'error');
        if (!editing) {
          editing = true;
          drawUrl();
        }
        return false;
      }
      url.value = v;
      if (v !== app.settings.workerUrl) await app.saveSettings({ ...app.settings, workerUrl: v });
      return true;
    };
    const loginBtn = h('button', { class: 'btn primary', type: 'button' }, 'ログイン');
    loginBtn.addEventListener('click', async () => {
      if (!(await saveUrl())) return;
      if (!id.value.trim() || !pw.value) {
        say('ID とパスワードを入れてください', 'error');
        return;
      }
      loginBtn.disabled = true;
      say('ログインしています…');
      const r = await login(app, id.value.trim(), pw.value);
      loginBtn.disabled = false;
      if (!r.ok) {
        say(`ログインできません：${errorText(r)}`, 'error');
        return;
      }
      toast(app.settings.authUser && app.settings.authUser.role === 'student'
        ? 'ログインしました（部員用・見るだけ）。試合を受け取ります'
        : 'ログインしました。この端末の記録を共有に送ります');
      app.go('#/settings');
    });

    // 最初の管理者
    const sName = input({ type: 'text', placeholder: '例：山田', 'aria-label': '表示名', maxlength: '30' });
    const sId = input({ type: 'text', placeholder: '例：yamada', 'aria-label': '管理者の ID' });
    const sPw = input({ type: 'password', autocomplete: 'new-password', placeholder: '8字以上', 'aria-label': '管理者のパスワード' });
    const sPw2 = input({ type: 'password', autocomplete: 'new-password', placeholder: 'もう一度', 'aria-label': '管理者のパスワード（確認）' });
    const sPass = input({ type: 'password', value: app.settings.staffPass || '', placeholder: 'Worker の STAFF_PASS', 'aria-label': 'スタッフ用パスコード（最初の管理者）' });
    const sStatus = h('p', { class: 'ai-conn-status', 'aria-live': 'polite' });
    const setupBtn = h('button', { class: 'btn primary', type: 'button' }, '管理者を作ってログイン');
    setupBtn.addEventListener('click', async () => {
      if (!(await saveUrl())) return;
      if (sPw.value !== sPw2.value) {
        sStatus.textContent = 'パスワードが一致しません';
        sStatus.className = 'ai-conn-status error';
        return;
      }
      setupBtn.disabled = true;
      sStatus.textContent = '作っています…';
      sStatus.className = 'ai-conn-status';
      const r = await setupAdmin(app, { loginId: sId.value.trim(), displayName: sName.value.trim(), password: sPw.value, setupPass: sPass.value });
      setupBtn.disabled = false;
      if (!r.ok) {
        // 最初の管理者で「認証できない」のは、スタッフ用パスコードが Worker の STAFF_PASS と違うとき
        sStatus.textContent = r.reason === 'unauthorized'
          ? '作れません：スタッフ用パスコードが違います。Cloudflare の Worker に登録したシークレット STAFF_PASS と同じもの（大文字・小文字も同じ）を入れてください'
          : `作れません：${errorText(r)}`;
        sStatus.className = 'ai-conn-status error';
        return;
      }
      toast('管理者を作り、ログインしました');
      app.go('#/settings');
    });

    return [
      h('h2', null, '記録の共有（ログイン）'),
      h('p', null, 'ログインすると、ノートパソコンや別の iPad でも同じ記録が見られます。記録はこれまでどおりこの端末にも保存するので、電波がなくても記録でき、つながったときに自動で同期します。'),
      urlBox,
      h('div', { class: 'grid-2' }, field('ID', id), field('パスワード', pw)),
      h('div', { class: 'row' }, loginBtn),
      status,
      h('details', { class: 'account-setup' },
        h('summary', null, '初めて使うとき（最初の管理者を作る）'),
        h('p', { class: 'field-note' }, 'はじめの1回だけ使います。Worker にデータベース（D1）をつないでから、Worker のシークレット STAFF_PASS（AI接続のスタッフ用パスコードと同じもの）を入れて作ります。ほかの先生のアカウントは、ログインしたあと「スタッフのアカウント」で作ります。'),
        h('div', { class: 'grid-2' },
          field('表示名', sName),
          field('ID', sId, '英小文字・数字・「. _ -」で3〜32字'),
          field('パスワード', sPw, '8字以上'),
          field('パスワード（確認）', sPw2),
          field('スタッフ用パスコード', sPass)),
        h('div', { class: 'row' }, setupBtn),
        sStatus),
      h('p', { class: 'field-note' }, 'デモ試合は共有しません。ログインしても、この端末の記録は消えません。'),
    ];
  }

  // ---- ログインしているとき ----
  function loggedInView() {
    const u = app.settings.authUser || {};
    const statusEl = h('p', { class: 'sync-status', 'aria-live': 'polite' });
    unsubscribe = onSyncStatus((s) => {
      statusEl.textContent = statusText(s, app.settings);
      statusEl.className = `sync-status ${s.state}`;
    });
    const syncBtn = h('button', { class: 'btn primary', type: 'button' }, icon('sync'), '今すぐ同期');
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      const r = await syncNow({ force: true });
      syncBtn.disabled = false;
      if (r.ok) toast(r.received ? `同期しました（受け取り ${r.received}件）` : '同期しました');
      if (!isLoggedIn(app.settings)) app.go('#/settings');
    });
    const outBtn = h('button', { class: 'btn', type: 'button' }, 'ログアウト');
    outBtn.addEventListener('click', async () => {
      const ok = await confirmDialog('ログアウトします。この端末の記録は消えません（送っていない変更は、次にログインしたときに送ります）。', { ok: 'ログアウト', title: 'ログアウト' });
      if (!ok) return;
      await logout(app);
      app.go('#/settings');
    });

    return [
      h('div', { class: 'card-head' },
        h('h2', null, '記録の共有（ログイン）'),
        h('span', { class: 'account-who' }, icon('check'), `${u.displayName || ''}（${ROLE_LABEL[u.role] || ''}）でログイン中`)),
      h('p', { class: 'muted' }, `ID：${u.loginId || ''}`),
      statusEl,
      h('div', { class: 'row' }, syncBtn, outBtn),
      // 部員（見るだけ）の端末では、接続先を送る・パスワードを変える（みんなで使うアカウントなので）を出さない
      u.role === 'student' ? null : connectSection(),
      u.role === 'student' ? null : passwordSection(),
      u.role === 'admin' ? usersSection(u) : null,
      u.role === 'student'
        ? h('p', { class: 'field-note' }, '部員用のアカウントです。先生が記録した試合の集計を見られます（見るだけ）。')
        : h('p', { class: 'field-note' }, '1つの試合は1台で記録してください（ほかの端末からは見るだけ）。2台で同時に記録すると、記録の順番が乱れることがあります。'),
    ];
  }

  /** ほかの端末でログインするとき：接続先（Worker の URL）をコピー・送信する */
  function connectSection() {
    const base = workerBase(app.settings.workerUrl);
    if (!base) return null;
    const msg = connectMessage(base);
    const status = h('p', { class: 'ai-conn-status', 'aria-live': 'polite' });
    const copyBtn = h('button', { class: 'btn', type: 'button' }, 'コピー');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(msg);
        status.textContent = 'コピーしました。ほかの端末のログインの画面で「接続先」に貼り付けてください';
        status.className = 'ai-conn-status ok';
      } catch {
        status.textContent = 'コピーできませんでした。下の URL を長押ししてコピーしてください';
        status.className = 'ai-conn-status error';
      }
    });
    const shareBtn = typeof navigator !== 'undefined' && navigator.share
      ? h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          try {
            await navigator.share({ title: 'BasketBall Analyst の接続先', text: msg });
          } catch {
            // 送るのをやめたときは何もしない
          }
        },
      }, icon('share'), '送る（AirDrop・メッセージ・メール）')
      : null;
    return h('details', { class: 'account-sub' },
      h('summary', null, 'ほかの端末でログインするとき（接続先を送る）'),
      h('p', { class: 'field-note' }, 'ほかの端末では、この接続先を一度だけ入れれば、次からは ID とパスワードだけでログインできます。iPad・iPhone は、ホーム画面に追加したアプリと Safari で保存が別なので、ホーム画面のアプリでも一度入れてください。スマートフォンのメモに残しておくと安心です。'),
      h('p', { class: 'connect-url' }, base),
      h('div', { class: 'row' }, copyBtn, shareBtn),
      status);
  }

  function passwordSection() {
    const cur = input({ type: 'password', 'aria-label': '今のパスワード' });
    const next = input({ type: 'password', placeholder: '8字以上', 'aria-label': '新しいパスワード' });
    const next2 = input({ type: 'password', 'aria-label': '新しいパスワード（確認）' });
    const status = h('p', { class: 'ai-conn-status', 'aria-live': 'polite' });
    const btn = h('button', { class: 'btn', type: 'button' }, 'パスワードを変える');
    btn.addEventListener('click', async () => {
      if (next.value !== next2.value) {
        status.textContent = '新しいパスワードが一致しません';
        status.className = 'ai-conn-status error';
        return;
      }
      btn.disabled = true;
      const r = await changePassword(app, cur.value, next.value);
      btn.disabled = false;
      status.textContent = r.ok ? '変えました（ほかの端末はログインし直しになります）' : `変えられません：${errorText(r)}`;
      status.className = `ai-conn-status ${r.ok ? 'ok' : 'error'}`;
      if (r.ok) {
        cur.value = '';
        next.value = '';
        next2.value = '';
      }
    });
    return h('details', { class: 'account-sub' },
      h('summary', null, '自分のパスワードを変える'),
      h('div', { class: 'grid-2' }, field('今のパスワード', cur), field('新しいパスワード', next), field('新しいパスワード（確認）', next2)),
      h('div', { class: 'row' }, btn),
      status);
  }

  function usersSection(me) {
    const list = h('div', { class: 'user-list' }, h('p', { class: 'muted' }, '読み込んでいます…'));
    const status = h('p', { class: 'ai-conn-status', 'aria-live': 'polite' });
    const say = (text, ok) => {
      status.textContent = text;
      status.className = `ai-conn-status ${ok ? 'ok' : 'error'}`;
    };

    async function load() {
      const r = await listUsers(app);
      if (!r.ok) {
        replace(list, h('p', { class: 'muted' }, `読み込めません：${errorText(r)}`));
        return;
      }
      replace(list, r.data.users.map((u) => userRow(u)));
    }

    async function act(promise, okText) {
      const r = await promise;
      if (r.ok) {
        say(okText, true);
        await load();
      } else say(`できません：${errorText(r)}`, false);
    }

    function userRow(u) {
      const self = u.id === me.id;
      const buttons = [];
      buttons.push(h('button', {
        class: 'btn small', type: 'button',
        onclick: async () => {
          const pw = window.prompt(`${u.displayName}（${u.loginId}）の新しいパスワード（8字以上）`);
          if (pw == null) return;
          act(updateUser(app, { id: u.id, password: pw }), 'パスワードを再設定しました（その人はログインし直し）');
        },
      }, 'パスワード再設定'));
      if (!self) {
        // 部員（見るだけ）の役割は変えない（変えるときは、消して作り直す）
        if (u.role !== 'student') {
          buttons.push(h('button', {
            class: 'btn small', type: 'button',
            onclick: () => act(updateUser(app, { id: u.id, role: u.role === 'admin' ? 'staff' : 'admin' }), '役割を変えました'),
          }, u.role === 'admin' ? 'スタッフにする' : '管理者にする'));
        }
        buttons.push(h('button', {
          class: 'btn small', type: 'button',
          onclick: () => act(updateUser(app, { id: u.id, disabled: !u.disabled }), u.disabled ? '使えるようにしました' : '使えなくしました（ログインが切れます）'),
        }, u.disabled ? '使えるようにする' : '使えなくする'));
        buttons.push(h('button', {
          class: 'btn small danger', type: 'button',
          onclick: async () => {
            const ok = await confirmDialog(`${u.displayName}（${u.loginId}）のアカウントを消します。記録は消えません。`, { ok: '消す', danger: true, title: 'アカウントを消す' });
            if (ok) act(deleteUser(app, u.id), 'アカウントを消しました');
          },
        }, '消す'));
      }
      return h('div', { class: ['user-row', u.disabled && 'disabled'] },
        h('div', { class: 'user-main' },
          h('span', { class: 'user-name' }, u.displayName, self ? '（自分）' : ''),
          h('span', { class: 'muted' }, `${u.loginId}　${ROLE_LABEL[u.role] || u.role}${u.disabled ? '　使えない' : ''}`)),
        h('div', { class: 'user-actions' }, buttons));
    }

    const nName = input({ type: 'text', placeholder: '例：佐藤', maxlength: '30', 'aria-label': '新しいアカウントの表示名' });
    const nId = input({ type: 'text', placeholder: '例：sato', 'aria-label': '新しいアカウントの ID' });
    const nPw = input({ type: 'text', placeholder: '8字以上', 'aria-label': '新しいアカウントの最初のパスワード' });
    const nRole = h('select', { 'aria-label': '役割' },
      h('option', { value: 'staff' }, 'スタッフ'),
      h('option', { value: 'student' }, '部員（見るだけ）'),
      h('option', { value: 'admin' }, '管理者'));
    const addBtn = h('button', { class: 'btn primary', type: 'button' }, icon('plus'), '追加');
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      const r = await createUser(app, { displayName: nName.value.trim(), loginId: nId.value.trim(), password: nPw.value, role: nRole.value });
      addBtn.disabled = false;
      if (r.ok) {
        say(`${r.data.user.displayName} を追加しました。ID と最初のパスワードを本人に伝え、ログイン後に変えてもらってください`, true);
        nName.value = '';
        nId.value = '';
        nPw.value = '';
        await load();
      } else say(`追加できません：${errorText(r)}`, false);
    });

    const details = h('details', { class: 'account-sub' },
      h('summary', null, 'アカウント（スタッフ・部員。管理者だけ）'),
      list,
      h('h3', null, 'アカウントを追加'),
      h('div', { class: 'grid-2' },
        field('表示名', nName), field('ID', nId, '英小文字・数字・「. _ -」で3〜32字'),
        field('最初のパスワード', nPw, '8字以上。本人がログイン後に変える'), field('役割', nRole, 'スタッフ：記録・編集できる（AI は見えない）。部員：一覧と集計を見るだけ。管理者：すべて（AI・アカウントの管理）')),
      h('div', { class: 'row' }, addBtn),
      status,
      h('p', { class: 'field-note' }, '部員（見るだけ）のアカウントは、試合の一覧と集計（チーム全体の数字・全員の個人スタッツ）だけを見られます。記録の修正、振り返り、Q&A、AI、チェック項目、動画は見られません。部員みんなで1つを使うときは、パスワードを5回まちがえると15分ロックされる点に気をつけてください。'));
    details.addEventListener('toggle', () => {
      if (details.open) load();
    });
    return details;
  }

  draw();
  return { el: card, cleanup: () => unsubscribe && unsubscribe() };
}
