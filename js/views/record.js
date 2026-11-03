// 記録画面（SPEC 3章）
// 左：ハーフコート図＋直近10件のログ　右：自チーム／相手、選手ボタン、プレーボタン　上：クォーター・スコア・ファウル・守備隊形
import * as db from '../db.js';
import { h, replace, toast, modal, confirmDialog } from '../ui.js';
import {
  makeEvent, nextSeq, quarterState, quarterLabel, describeEvent, whoLabel, sortNumbers, uuid,
  TEAM_LABEL, SHOT_TAGS, TO_TAGS, REGULAR_QUARTERS, defenseSide,
} from '../model.js';
import { ZONE_LABELS, zoneOf } from '../court.js';
import { scoreOf, teamFouls, playerFouls } from '../stats.js';
import { initialInput, step, hintFor, ACTIONS, US_ONLY } from '../input.js';
import { createCourt, drawShots, drawPending } from '../court-svg.js';

const PLAY_BUTTONS = [
  'ft_made', 'ft_miss', 'oreb', 'dreb',
  'to', 'ast', 'stl', 'blk',
  'foul', 'timeout', 'adjust', 'cancel',
];

export async function renderRecord(root, params, app) {
  const game = await db.getGame(params.gameId);
  if (!game) {
    toast('試合が見つかりません', { kind: 'error' });
    app.go('#/');
    return undefined;
  }
  if (!game.live) game.live = { usDF: app.settings.defenses[0], oppDF: app.settings.defenses[0] };
  let events = await db.listEvents(game.id);
  let input = initialInput();
  let lastAddedId = null;
  let lastMessage = ''; // 直前に記録した内容（右側の案内欄に出す）

  // ---- 保存 ----
  const saveError = (err) => {
    console.error(err);
    toast('保存できませんでした。端末の空き容量を確認してください。', { kind: 'error', ms: 5000 });
  };
  const saveGame = () => db.putGame(game).catch(saveError);

  function currentQuarter() {
    return quarterState(events).quarter;
  }

  function addEvent(draft) {
    const e = makeEvent(draft, {
      gameId: game.id,
      seq: nextSeq(events),
      quarter: draft.quarter || currentQuarter(),
      live: game.live,
      ts: Date.now(),
    });
    events.push(e);
    lastAddedId = e.id;
    db.putEvent(e).catch(saveError);
    return e;
  }

  function patchEvent(id, patch) {
    const e = events.find((x) => x.id === id);
    if (!e) return;
    Object.assign(e, patch);
    db.putEvent(e).catch(saveError);
  }

  function removeEvent(id) {
    events = events.filter((x) => x.id !== id);
    if (input.tagEventId === id) input = initialInput();
    db.deleteEvent(id).catch(saveError);
  }

  // ---- 入力 ----
  const ctx = {
    newId: uuid,
    isDisabled: (team, player) => (fouls()[team][player] || 0) >= 5,
  };
  const fouls = () => playerFouls(events);

  function dispatch(cmd) {
    const r = step(input, cmd, ctx);
    input = r.state;
    if (r.ops.length === 0 && cmd.type !== 'tag') lastMessage = '';
    for (const op of r.ops) {
      if (op.op === 'add') {
        const e = addEvent(op.draft);
        lastMessage = `記録：${describeEvent(e, ZONE_LABELS)}`;
      } else if (op.op === 'patch') patchEvent(op.id, op.patch);
    }
    if (r.error) toast(r.error, { kind: 'error' });
    update();
  }

  // ---- 画面の骨組み ----
  const top = h('header', { class: 'rec-top' });
  const court = createCourt({ onTap: (x, y) => dispatch({ type: 'court', x, y }), label: 'ハーフコート。タップでシュート位置' });
  const courtWrap = h('div', { class: 'rec-court' }, court.svg);
  const log = h('div', { class: 'rec-log', 'aria-label': '直近10件の記録' });
  const teamToggle = h('div', { class: 'team-toggle', role: 'tablist' });
  const players = h('div', { class: 'players' });
  const context = h('div', { class: 'context', 'aria-live': 'polite' });
  const plays = h('div', { class: 'plays' });
  // 試合前・クォーター間の案内はコートの上だけに出す（ログからの修正はいつでもできるように）
  const overlay = h('div', { class: 'phase-overlay' });
  courtWrap.appendChild(overlay);
  const rightPanel = h('aside', { class: 'rec-right' }, teamToggle, players, context, plays);
  const recEl = h('div', { class: 'rec' },
    top,
    h('main', { class: 'rec-left' }, courtWrap, log),
    rightPanel);
  root.append(recEl);

  function setMessage(text) {
    lastMessage = text;
  }

  // ---- 上部バー ----
  function renderTop() {
    const qs = quarterState(events);
    const score = scoreOf(events);
    const tf = teamFouls(events, qs.quarter);
    const qText = qs.phase === 'pre' ? '試合前' : quarterLabel(qs.quarter) + (qs.phase === 'break' ? ' 終了' : '');
    const dfButton = (side) => {
      const value = side === 'us' ? game.live.usDF : game.live.oppDF;
      return h('button', {
        class: ['df-btn', side], type: 'button', onclick: () => pickDefense(side),
        'aria-label': `${side === 'us' ? '自チーム' : '相手'}の守備隊形：${value}。タップで変更`,
      }, h('span', { class: 'df-label' }, side === 'us' ? '自DF' : '相手DF'), h('span', { class: 'df-value' }, value || '未設定'));
    };
    const qButton =
      qs.phase === 'live'
        ? h('button', { class: 'btn q-btn', type: 'button', onclick: endQuarter }, 'クォーター終了')
        : h('button', { class: 'btn q-btn primary', type: 'button', onclick: () => startQuarter(qs.next) }, `${quarterLabel(qs.next)} 開始`);
    replace(top,
      h('button', { class: 'btn menu-btn', type: 'button', onclick: openMenu, 'aria-label': 'メニュー' }, 'メニュー'),
      h('div', { class: 'q-now' }, qText),
      h('div', { class: 'scoreboard', 'aria-label': `スコア 自チーム${score.us} 相手${score.opp}` },
        h('span', { class: 'sb-name us' }, '自チーム'),
        h('span', { class: 'sb-num us' }, score.us),
        h('span', { class: 'sb-sep' }, '−'),
        h('span', { class: 'sb-num opp' }, score.opp),
        h('span', { class: 'sb-name opp' }, game.opponent || '相手')),
      h('div', { class: 'tf' },
        h('span', { class: 'tf-label' }, 'チームファウル'),
        h('span', { class: ['tf-val', tf.us >= 5 && 'over'] }, `自 ${tf.us}`),
        h('span', { class: ['tf-val', tf.opp >= 5 && 'over'] }, `相手 ${tf.opp}`)),
      dfButton('us'),
      dfButton('opp'),
      h('button', { class: 'btn undo-btn', type: 'button', onclick: undo, disabled: events.length === 0 }, '取り消し'),
      qButton);
  }

  // ---- コート ----
  function renderCourt() {
    const q = currentQuarter();
    const shots = events.filter((e) => e.type === 'fg' && e.quarter === q);
    drawShots(court.layers.shots, shots, { faded: true, highlightId: lastAddedId });
    const team = input.sel ? input.sel.team : input.team;
    drawPending(court.layers.pending, input.loc, { three: input.three, team });
  }

  // ---- 自チーム／相手 ----
  function renderTeamToggle() {
    replace(teamToggle, ['us', 'opp'].map((t) =>
      h('button', {
        class: ['tt-btn', t, input.team === t && 'on'], type: 'button', role: 'tab',
        'aria-selected': String(input.team === t),
        onclick: () => dispatch({ type: 'team', team: t }),
      }, t === 'us' ? '自チーム' : `相手${game.opponent ? `（${game.opponent}）` : ''}`)));
  }

  // ---- 選手ボタン ----
  function oppNumberList() {
    const set = new Set(game.oppNumbers || []);
    for (const e of events) if (e.team === 'opp' && e.player != null) set.add(e.player);
    return sortNumbers([...set]);
  }

  function playerButton(team, number, name, pfAll) {
    const pf = number == null ? 0 : pfAll[team][number] || 0;
    const selected = input.sel && input.sel.team === team && input.sel.player === number;
    const out = pf >= 5;
    const badge = pf ? h('span', { class: ['pf', `pf${Math.min(pf, 5)}`], 'aria-label': `ファウル${pf}` }, pf) : null;
    return h('button', {
      class: ['pl-btn', team, selected && 'on', out && 'out', number == null && 'nobody'],
      type: 'button',
      disabled: out,
      onclick: () => dispatch({ type: 'player', team, player: number }),
      'aria-pressed': String(!!selected),
    },
    h('span', { class: 'pl-num' }, number == null ? (team === 'us' ? 'チーム' : '番号なし') : number),
    name ? h('span', { class: 'pl-name' }, name) : null,
    badge);
  }

  function renderPlayers() {
    const pf = fouls();
    if (input.team === 'us') {
      replace(players,
        game.roster.map((p) => playerButton('us', String(p.number), p.name, pf)),
        playerButton('us', null, '', pf));
    } else {
      replace(players,
        oppNumberList().map((n) => playerButton('opp', n, '', pf)),
        h('button', { class: 'pl-btn opp add', type: 'button', onclick: addOppNumber }, h('span', { class: 'pl-num' }, '＋'), h('span', { class: 'pl-name' }, '番号')),
        playerButton('opp', null, '', pf));
    }
    players.classList.toggle('waiting', !!(input.loc || input.action) && !input.sel);
  }

  // ---- 状況に応じた選択（成功／失敗、種類タグ、タイムアウト、得点補正） ----
  function renderContext() {
    const sheet = input.sheet;
    context.className = `context ${sheet || 'hint'}`;
    if (sheet === 'fg') {
      const zone = zoneOf(input.loc.x, input.loc.y, input.three);
      replace(context,
        h('div', { class: 'ctx-title' }, `${whoLabel(input.sel.team, input.sel.player)}　${ZONE_LABELS[zone]}`),
        h('div', { class: 'ctx-row fg-row' },
          h('button', { class: 'btn made big', type: 'button', onclick: () => dispatch({ type: 'fgResult', made: true }) }, '成功'),
          h('button', { class: 'btn miss big', type: 'button', onclick: () => dispatch({ type: 'fgResult', made: false }) }, '失敗'),
          h('button', {
            class: 'btn toggle3', type: 'button', onclick: () => dispatch({ type: 'toggle3' }),
            'aria-label': `いまは${input.three ? '3P' : '2P'}。タップで切り替え`,
          }, h('span', { class: 'big-text' }, input.three ? '3P' : '2P'), h('span', { class: 'small-text' }, '2P⇄3P')),
          h('button', { class: 'btn', type: 'button', onclick: () => dispatch({ type: 'cancel' }) }, 'やめる')));
      return;
    }
    if (sheet === 'tags') {
      const list = input.tagKind === 'to' ? TO_TAGS : SHOT_TAGS;
      replace(context,
        h('div', { class: 'ctx-title one-line' },
          lastMessage ? h('span', { class: 'ctx-done' }, lastMessage) : null,
          h('span', { class: 'ctx-sub' }, '種類（任意）')),
        h('div', { class: ['ctx-row', 'tag-row', input.tagKind] },
          list.map((t) => h('button', {
            class: ['btn tag-btn', input.tags.includes(t) && 'on'], type: 'button',
            'aria-pressed': String(input.tags.includes(t)),
            onclick: () => dispatch({ type: 'tag', tag: t }),
          }, t)),
          h('button', { class: 'btn', type: 'button', onclick: () => dispatch({ type: 'cancel' }) }, '閉じる')));
      return;
    }
    if (sheet === 'timeout') {
      replace(context,
        h('div', { class: 'ctx-title' }, 'タイムアウト'),
        h('div', { class: 'ctx-row' },
          h('button', { class: 'btn big us-fill', type: 'button', onclick: () => dispatch({ type: 'timeout', team: 'us' }) }, '自チーム'),
          h('button', { class: 'btn big opp-fill', type: 'button', onclick: () => dispatch({ type: 'timeout', team: 'opp' }) }, '相手'),
          h('button', { class: 'btn', type: 'button', onclick: () => dispatch({ type: 'cancel' }) }, 'やめる')));
      return;
    }
    if (sheet === 'adjust') {
      const cells = (team) => [
        h('span', { class: ['adj-team', team] }, TEAM_LABEL[team]),
        [1, 2, 3].map((p) => h('button', {
          class: ['btn', `${team}-fill`], type: 'button', onclick: () => dispatch({ type: 'adjust', team, points: p }),
        }, `+${p}`)),
      ];
      replace(context,
        h('div', { class: 'ctx-title' }, '得点補正（選手不明の得点を合わせる）'),
        h('div', { class: 'adjust-grid' },
          cells('us'),
          h('button', { class: 'btn adj-cancel', type: 'button', onclick: () => dispatch({ type: 'cancel' }) }, 'やめる'),
          cells('opp')));
      return;
    }
    const idle = !input.sel && !input.loc && !input.action;
    replace(context,
      idle && lastMessage ? h('p', { class: 'ctx-done big' }, lastMessage) : null,
      h('p', { class: 'hint-text' }, hintFor(input)));
  }

  // ---- プレーボタン ----
  function renderPlays() {
    const team = input.sel ? input.sel.team : input.team;
    replace(plays, PLAY_BUTTONS.map((key) => {
      if (key === 'timeout' || key === 'adjust') {
        return h('button', {
          class: ['play-btn', 'meta', input.sheet === key && 'on'], type: 'button',
          onclick: () => dispatch({ type: 'sheet', sheet: key }),
        }, breakable(key === 'timeout' ? 'タイムアウト' : '得点補正'));
      }
      if (key === 'cancel') {
        const busy = input.sel || input.loc || input.action;
        return h('button', { class: 'play-btn meta', type: 'button', disabled: !busy, onclick: () => dispatch({ type: 'cancel' }) }, breakable('選択を解除'));
      }
      const a = ACTIONS[key];
      const disabled = US_ONLY.has(key) && team !== 'us';
      return h('button', {
        class: ['play-btn', key, input.action === key && 'on'], type: 'button', disabled,
        onclick: () => dispatch({ type: 'play', action: key }),
      }, breakable(a.label));
    }));
  }

  // ---- 直近10件のログ ----
  function renderLog() {
    const recent = events.slice(-10).reverse();
    if (!recent.length) {
      replace(log, h('p', { class: 'log-empty' }, '記録はまだありません'));
      return;
    }
    replace(log, recent.map((e) =>
      h('button', {
        class: ['log-item', e.team || 'none', e.id === lastAddedId && 'latest'], type: 'button',
        onclick: () => editEvent(e),
      },
      h('span', { class: 'log-q' }, quarterLabel(e.quarter)),
      h('span', { class: 'log-text' }, describeEvent(e, ZONE_LABELS)))));
  }

  // ---- 試合前・クォーター間 ----
  function renderOverlay() {
    const qs = quarterState(events);
    recEl.classList.toggle('paused', qs.phase !== 'live');
    if (qs.phase === 'live') {
      overlay.classList.remove('show');
      replace(overlay);
      return;
    }
    overlay.classList.add('show');
    const score = scoreOf(events);
    const isEndOfRegulation = qs.phase === 'break' && qs.quarter >= REGULAR_QUARTERS;
    replace(overlay, h('div', { class: 'phase-card' },
      qs.phase === 'pre'
        ? h('p', { class: 'phase-title' }, '試合開始前')
        : h('p', { class: 'phase-title' }, `${quarterLabel(qs.quarter)} 終了　自チーム ${score.us} − ${score.opp} 相手`),
      qs.phase === 'pre'
        ? h('p', { class: 'muted' }, '「自DF」「相手DF」を確かめてから、開始をタップしてください。')
        : h('p', { class: 'muted' }, '下のログをタップすると記録を修正できます。'),
      h('button', { class: 'btn primary huge', type: 'button', onclick: () => startQuarter(qs.next) }, `${quarterLabel(qs.next)} 開始`),
      isEndOfRegulation ? h('p', { class: 'muted' }, '延長がない場合は、ここで記録は終わりです。') : null,
      h('div', { class: 'row center' },
        qs.phase === 'break' ? h('a', { class: 'btn', href: `#/game/${game.id}/summary` }, '集計を見る') : null,
        h('a', { class: 'btn', href: '#/' }, 'ホームへ'))));
  }

  function update() {
    renderTop();
    renderCourt();
    renderTeamToggle();
    renderPlayers();
    renderContext();
    renderPlays();
    renderLog();
    renderOverlay();
  }

  // ---- 操作 ----
  function startQuarter(q) {
    input = initialInput();
    addEvent({ type: 'q_start', team: null, quarter: q });
    setMessage(`${quarterLabel(q)} 開始`);
    toast(`${quarterLabel(q)} 開始`);
    update();
  }

  async function endQuarter() {
    const qs = quarterState(events);
    const ok = await confirmDialog(`${quarterLabel(qs.quarter)}を終了しますか？`, { ok: '終了する', title: 'クォーター終了' });
    if (!ok) return;
    input = initialInput();
    addEvent({ type: 'q_end', team: null, quarter: qs.quarter });
    update();
  }

  function undo() {
    const last = events[events.length - 1];
    if (!last) return;
    removeEvent(last.id);
    lastAddedId = null;
    input = { ...initialInput(), team: input.team };
    toast(`取り消し：${describeEvent(last, ZONE_LABELS)}`);
    update();
  }

  function pickDefense(side) {
    const current = side === 'us' ? game.live.usDF : game.live.oppDF;
    const options = [...app.settings.defenses];
    if (current && !options.includes(current)) options.push(current);
    const close = modal({
      title: side === 'us' ? '自チームの守備隊形（自DF）' : '相手の守備隊形（相手DF）',
      body: h('div', { class: 'df-options' }, options.map((d) =>
        h('button', {
          class: ['btn df-option', d === current && 'on'], type: 'button',
          onclick: () => {
            if (side === 'us') game.live.usDF = d;
            else game.live.oppDF = d;
            saveGame();
            close();
            setMessage(`${side === 'us' ? '自DF' : '相手DF'}：${d}`);
            update();
          },
        }, d))),
      actions: [{ label: 'やめる' }],
      wide: true,
    });
  }

  function addOppNumber() {
    let value = '';
    const display = h('div', { class: 'keypad-display' }, '');
    const show = () => { display.textContent = value || '背番号'; display.classList.toggle('placeholder', !value); };
    show();
    const key = (k) => h('button', {
      class: 'btn keypad-key', type: 'button',
      onclick: () => {
        if (k === '←') value = value.slice(0, -1);
        else if (value.length < 2) value += k;
        show();
      },
    }, k);
    const close = modal({
      title: '相手の背番号を追加',
      body: h('div', { class: 'keypad' }, display,
        h('div', { class: 'keypad-grid' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '←', '0'].map(key))),
      actions: [
        { label: 'やめる' },
        {
          label: '追加',
          kind: 'primary',
          onClick: () => {
            if (!/^\d{1,2}$/.test(value)) {
              toast('背番号を入力してください', { kind: 'error' });
              return false;
            }
            if (!(game.oppNumbers || []).includes(value)) {
              game.oppNumbers = sortNumbers([...(game.oppNumbers || []), value]);
              saveGame();
            }
            close();
            // 追加した番号をそのまま選んだことにする（シュート・プレー待ちならそのまま記録へ）
            dispatch({ type: 'player', team: 'opp', player: value });
            return undefined;
          },
        },
      ],
    });
  }

  function openMenu() {
    const close = modal({
      title: `vs ${game.opponent || '相手'}`,
      body: h('div', { class: 'menu-list' },
        h('a', { class: 'btn', href: `#/game/${game.id}/summary`, onclick: () => close() }, '集計を見る'),
        h('a', { class: 'btn', href: `#/game/${game.id}/edit`, onclick: () => close() }, '試合設定を編集（名簿・相手の背番号）'),
        h('a', { class: 'btn', href: '#/', onclick: () => close() }, 'ホームへ戻る')),
      actions: [{ label: '閉じる' }],
    });
  }

  // ---- ログから修正・削除 ----
  function editEvent(e) {
    const body = h('div', { class: 'edit-body' });
    let confirmDelete = false;
    const save = (patch) => {
      patchEvent(e.id, patch);
      draw();
      update();
    };
    const choice = (label, on, onclick, extra) => h('button', { class: ['btn choice', on && 'on', extra], type: 'button', onclick }, label);

    function draw() {
      const parts = [h('p', { class: 'edit-desc' }, `${quarterLabel(e.quarter)}　${describeEvent(e, ZONE_LABELS)}`)];
      const hasPlayer = e.team && !['timeout', 'adjust', 'q_start', 'q_end'].includes(e.type);
      if (hasPlayer) {
        const nums = e.team === 'us' ? game.roster.map((p) => String(p.number)) : oppNumberList();
        const canNull = e.team === 'opp' || ['oreb', 'dreb', 'to'].includes(e.type);
        parts.push(h('div', { class: 'edit-sec' }, h('h3', null, '選手'),
          h('div', { class: 'choice-grid' },
            nums.map((n) => choice(n, e.player === n, () => save({ player: n }), e.team)),
            canNull ? choice(e.team === 'us' ? 'チーム' : '番号なし', e.player == null, () => save({ player: null }), e.team) : null)));
      }
      if (e.type === 'fg' || e.type === 'ft') {
        parts.push(h('div', { class: 'edit-sec' }, h('h3', null, '結果'),
          h('div', { class: 'choice-grid' },
            choice('成功', e.made, () => save({ made: true })),
            choice('失敗', !e.made, () => save({ made: false })))));
      }
      if (e.type === 'fg') {
        parts.push(h('div', { class: 'edit-sec' }, h('h3', null, '2P／3P'),
          h('div', { class: 'choice-grid' },
            [2, 3].map((p) => choice(`${p}P`, e.points === p, () => save({ points: p, zone: zoneOf(e.x, e.y, p === 3) }))))));
      }
      if (e.type === 'fg' || e.type === 'to') {
        const list = e.type === 'fg' ? SHOT_TAGS : TO_TAGS;
        parts.push(h('div', { class: 'edit-sec' }, h('h3', null, '種類タグ'),
          h('div', { class: 'choice-grid' }, list.map((t) => choice(t, e.tags.includes(t), () =>
            save({ tags: e.tags.includes(t) ? e.tags.filter((x) => x !== t) : [...e.tags, t] }))))));
      }
      if (e.type === 'adjust') {
        parts.push(h('div', { class: 'edit-sec' }, h('h3', null, '補正'),
          h('div', { class: 'choice-grid' }, [1, 2, 3].map((p) => choice(`+${p}`, e.points === p, () => save({ points: p }))))));
      }
      if (e.type === 'timeout' || e.type === 'adjust') {
        parts.push(h('div', { class: 'edit-sec' }, h('h3', null, 'チーム'),
          h('div', { class: 'choice-grid' }, ['us', 'opp'].map((t) => choice(TEAM_LABEL[t], e.team === t, () => save({ team: t }), t)))));
      }
      const side = defenseSide(e.type, e.team);
      if (side) {
        const opts = [...app.settings.defenses];
        if (e.defense && !opts.includes(e.defense)) opts.push(e.defense);
        parts.push(h('div', { class: 'edit-sec' }, h('h3', null, side === 'us' ? '守備隊形（自DF）' : '守備隊形（相手DF）'),
          h('div', { class: 'choice-grid' }, opts.map((d) => choice(d, e.defense === d, () => save({ defense: d }))))));
      }
      parts.push(h('div', { class: 'edit-sec' },
        h('button', {
          class: 'btn danger', type: 'button',
          onclick: () => {
            if (!confirmDelete) {
              confirmDelete = true;
              draw();
              return;
            }
            removeEvent(e.id);
            closeModal();
            toast(`削除：${describeEvent(e, ZONE_LABELS)}`);
            update();
          },
        }, confirmDelete ? 'もう一度タップで削除' : 'この記録を削除')));
      replace(body, parts);
    }
    draw();
    const closeModal = modal({ title: '記録の修正', body, actions: [{ label: '閉じる', kind: 'primary' }], wide: true });
  }

  // iPad で記録中に画面が動かないように
  const stopScroll = (ev) => {
    if (!ev.target.closest('.modal')) ev.preventDefault();
  };
  document.addEventListener('touchmove', stopScroll, { passive: false });

  update();

  return () => {
    document.removeEventListener('touchmove', stopScroll);
  };
}

/** 長い語は決まった位置でだけ折り返す（「ターン／オーバー」） */
const BREAKS = { ターンオーバー: 'ターン\u200bオーバー', タイムアウト: 'タイム\u200bアウト', 得点補正: '得点\u200b補正', 選択を解除: '選択を\u200b解除' };
function breakable(label) {
  return BREAKS[label] || label;
}
