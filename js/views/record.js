// 記録画面（SPEC 3章）
// 左：ハーフコート図＋直近10件のログ
// 右：自チーム（コートの5人とベンチ）と相手の選手ボタンを同時に表示、続きのプレー、プレーボタン
// 上：試合時計、スコア、チームファウル、守備隊形、取り消し、クォーター終了
import * as db from '../db.js';
import { h, replace, toast, modal, confirmDialog, icon } from '../ui.js';
import {
  makeEvent, nextSeq, quarterState, quarterLabel, describeEvent, whoLabel, sortNumbers, uuid,
  TEAM_LABEL, SHOT_TAGS, TO_TAGS, REGULAR_QUARTERS, defenseSide,
} from '../model.js';
import { ZONE_LABELS, zoneOf } from '../court.js';
import { scoreOf, teamFouls, playerFouls } from '../stats.js';
import { initialInput, step, hintFor, ACTIONS, US_ONLY } from '../input.js';
import { createCourt, drawShots, drawPending } from '../court-svg.js';
import {
  quarterSeconds, newClock, isRunning, remainingAt, startClock, stopClock, setRemaining, adjustClock, settleClock,
  clockForEvent, formatClock,
} from '../clock.js';
import { onCourt, benchOf, swapPlan, addToRoster, defaultStarters, COURT_SIZE } from '../lineup.js';

const PLAY_BUTTONS = [
  'ft_made', 'ft_miss', 'oreb', 'dreb',
  'to', 'ast', 'stl', 'blk',
  'foul', 'timeout', 'adjust', 'cancel',
];

/** 記録したら時計を止めるプレー（設定で切り替え） */
const CLOCK_STOPS = new Set(['foul', 'timeout']);

export async function renderRecord(root, params, app) {
  const game = await db.getGame(params.gameId);
  if (!game) {
    toast('試合が見つかりません', { kind: 'error' });
    app.go('#/');
    return undefined;
  }
  if (!game.live) game.live = { usDF: app.settings.defenses[0], oppDF: app.settings.defenses[0] };
  if (!Array.isArray(game.roster)) game.roster = [];
  let events = await db.listEvents(game.id);
  let input = initialInput();
  let lastAddedId = null;
  let lastMessage = ''; // 直前に記録した内容（右側の案内欄に出す）
  let lastSave = Promise.resolve();
  const starters = { us: null, opp: null }; // 試合開始前に選んでいる先発（背番号の配列）
  const summaryHref = (q) => `#/game/${game.id}/quarter/${q}`;

  // ---- 保存 ----
  const saveError = (err) => {
    console.error(err);
    toast('保存できませんでした。端末の空き容量を確認してください。', { kind: 'error', ms: 5000 });
  };
  const saveGame = () => db.putGame(game).catch(saveError);

  function currentQuarter() {
    return quarterState(events).quarter;
  }

  // ---- 試合時計 ----
  const clockOpts = () => ({ quarterMin: app.settings.quarterMin, otMin: app.settings.otMin, regular: REGULAR_QUARTERS });
  const clock = () => game.live.clock || null;
  function setClock(next) {
    game.live.clock = next;
    saveGame();
  }

  function addEvent(draft) {
    const quarter = draft.quarter || currentQuarter();
    const now = Date.now();
    const e = makeEvent(draft, {
      gameId: game.id,
      seq: nextSeq(events),
      quarter,
      live: game.live,
      ts: now,
      clock: clockForEvent(clock(), quarter, now),
    });
    events.push(e);
    lastAddedId = e.id;
    lastSave = db.putEvent(e).catch(saveError);
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
  const fouls = () => playerFouls(events);
  const ctx = {
    newId: uuid,
    isDisabled: (team, player) => (fouls()[team][player] || 0) >= 5,
  };
  const courtOf = (team) => onCourt(events, team);
  const court5 = () => courtOf('us');
  const TEAM_TITLE = (team) => (team === 'us' ? '自チーム' : '相手');

  function dispatch(cmd) {
    const r = step(input, cmd, ctx);
    input = r.state;
    if (r.ops.length === 0 && cmd.type !== 'tag') lastMessage = '';
    for (const op of r.ops) {
      if (op.op === 'add') {
        const e = addEvent(op.draft);
        lastMessage = `記録：${describeEvent(e, ZONE_LABELS)}`;
        if (CLOCK_STOPS.has(e.type) && app.settings.clockAutoStop !== false && isRunning(clock())) {
          setClock(stopClock(clock(), Date.now()));
          lastMessage += '（時計を止めました）';
        }
      } else if (op.op === 'patch') patchEvent(op.id, op.patch);
      else if (op.op === 'remove') removeEvent(op.id);
    }
    if (r.error) toast(r.error, { kind: 'error' });
    update();
  }

  // ---- 画面の骨組み ----
  const top = h('header', { class: 'rec-top' });
  const court = createCourt({ onTap: (x, y) => dispatch({ type: 'court', x, y }), label: 'ハーフコート。タップでシュート位置' });
  const courtWrap = h('div', { class: 'rec-court' }, court.svg);
  const log = h('div', { class: 'rec-log', 'aria-label': '直近10件の記録' });
  const usSide = h('section', { class: 'side us', 'aria-label': '自チームの選手' });
  const oppSide = h('section', { class: 'side opp', 'aria-label': '相手の選手' });
  const players = h('div', { class: 'players' }, usSide, oppSide);
  const context = h('div', { class: 'context', 'aria-live': 'polite' });
  const plays = h('div', { class: 'plays' });
  // 試合前・クォーター間の案内はコートの上だけに出す（ログからの修正はいつでもできるように）
  const overlay = h('div', { class: 'phase-overlay' });
  courtWrap.appendChild(overlay);
  const rightPanel = h('aside', { class: 'rec-right' }, players, context, plays);
  const recEl = h('div', { class: 'rec' },
    top,
    h('main', { class: 'rec-left' }, courtWrap, log),
    rightPanel);
  root.append(recEl);

  function setMessage(text) {
    lastMessage = text;
  }

  // ---- 上部バー ----
  let clockText = null;
  let clockShown = false;
  function renderTop() {
    const qs = quarterState(events);
    const score = scoreOf(events);
    const tf = teamFouls(events, qs.quarter);
    const c = clock();
    const hasClock = qs.phase !== 'pre' && c && c.quarter === qs.quarter;
    const running = isRunning(c);
    const dfButton = (side) => {
      const value = side === 'us' ? game.live.usDF : game.live.oppDF;
      return h('button', {
        class: ['df-btn', side], type: 'button', onclick: () => pickDefense(side),
        'aria-label': `${side === 'us' ? '自チーム' : '相手'}の守備隊形：${value}。タップで変更`,
      }, h('span', { class: 'df-label' }, side === 'us' ? '自DF' : '相手DF'), h('span', { class: 'df-value' }, value || '未設定'));
    };
    const qButton =
      qs.phase === 'live'
        ? h('button', { class: 'btn q-btn', type: 'button', onclick: endQuarter }, icon('flag'), 'クォーター終了')
        : h('button', { class: 'btn q-btn primary', type: 'button', onclick: () => startQuarter(qs.next) }, `${quarterLabel(qs.next)} 開始`);
    const qText = qs.phase === 'pre' ? '試合前' : quarterLabel(qs.quarter) + (qs.phase === 'break' ? ' 終了' : '');
    clockShown = !!hasClock;
    clockText = h('span', { class: 'clock-time' }, hasClock ? formatClock(remainingAt(c, Date.now())) : '--:--');
    const clockBtn = h('button', {
      class: ['clock-btn', running ? 'running' : 'stopped', !hasClock && 'none'], type: 'button',
      disabled: qs.phase !== 'live',
      onclick: toggleClock,
      'aria-label': running ? '時計を止める' : '時計を動かす',
    },
    h('span', { class: 'clock-q' }, qText),
    clockText,
    h('span', { class: 'clock-state' }, icon(running ? 'pause' : 'play'), running ? '止める' : '動かす'));
    replace(top,
      h('button', { class: 'btn menu-btn', type: 'button', onclick: openMenu, 'aria-label': 'メニュー' }, icon('menu')),
      clockBtn,
      h('button', {
        class: 'btn clock-adj', type: 'button', onclick: openClockAdjust, disabled: !hasClock && qs.phase !== 'live', 'aria-label': '時計を合わせる',
      }, icon('clock')),
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
      h('button', { class: 'btn undo-btn', type: 'button', onclick: undo, disabled: events.length === 0 }, icon('undo'), '取り消し'),
      qButton);
  }

  /** 時計の表示だけを更新する（0 になったら止めて保存） */
  function tick() {
    const c = clock();
    if (!c || !clockText || !clockShown) return;
    const now = Date.now();
    const settled = settleClock(c, now);
    if (settled !== c) {
      setClock(settled);
      toast(`${quarterLabel(c.quarter)} 残り 0:00。終わったら「クォーター終了」を押してください。`, { ms: 4000 });
      renderTop();
      return;
    }
    clockText.textContent = formatClock(remainingAt(c, now));
  }
  const timer = setInterval(tick, 250);

  /** いまのクォーターの時計（このクォーターを時計なしで始めていたら、止まった状態で作る） */
  function ensureClock() {
    const qs = quarterState(events);
    const c = clock();
    if (c && c.quarter === qs.quarter) return { clock: c, created: false };
    if (qs.phase !== 'live') return { clock: c, created: false };
    const next = newClock(qs.quarter, quarterSeconds(qs.quarter, clockOpts()));
    setClock(next);
    return { clock: next, created: true };
  }

  function toggleClock() {
    const { clock: c, created } = ensureClock();
    if (!c) return;
    if (created) {
      // 途中から時計を使うときは、まず残り時間を合わせる
      renderTop();
      openClockAdjust();
      toast('残り時間を合わせてから、時計をタップして動かしてください', { ms: 4000 });
      return;
    }
    const now = Date.now();
    setClock(isRunning(c) ? stopClock(c, now) : startClock(c, now));
    renderTop();
  }

  function openClockAdjust() {
    const { clock: c, created } = ensureClock();
    if (!c) return;
    if (created) renderTop();
    let digits = '';
    const display = h('div', { class: 'keypad-display clock-display' });
    const show = () => {
      if (digits) {
        const v = digits.padStart(3, '0');
        display.textContent = `${Number(v.slice(0, -2))}:${v.slice(-2)}`;
      } else {
        display.textContent = formatClock(remainingAt(clock(), Date.now()));
      }
      display.classList.toggle('typing', !!digits);
    };
    show();
    const live = setInterval(() => { if (!digits) show(); }, 250);
    const bump = (d) => h('button', {
      class: 'btn clock-bump', type: 'button',
      onclick: () => {
        digits = '';
        setClock(adjustClock(clock(), d, Date.now()));
        show();
        renderTop();
      },
    }, d > 0 ? `+${Math.abs(d) >= 60 ? `${d / 60}分` : `${d}秒`}` : `−${Math.abs(d) >= 60 ? `${-d / 60}分` : `${-d}秒`}`);
    const key = (k) => h('button', {
      class: 'btn keypad-key', type: 'button',
      onclick: () => {
        if (k === '←') digits = digits.slice(0, -1);
        else if (digits.length < 4) digits = (digits + k).replace(/^0+(?=\d)/, '');
        show();
      },
    }, k);
    const close = modal({
      title: `時計を合わせる（${quarterLabel(c.quarter)}）`,
      body: h('div', { class: 'clock-adjust' },
        display,
        h('div', { class: 'clock-bumps' }, [-60, -10, -1, 1, 10, 60].map(bump)),
        h('p', { class: 'muted small' }, '数字で入れるときは「532」で 5:32 になります。'),
        h('div', { class: 'keypad-grid' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '←', '0'].map(key))),
      actions: [
        { label: '閉じる' },
        {
          label: '数字の時間にする',
          kind: 'primary',
          onClick: () => {
            if (!digits) return undefined;
            const v = digits.padStart(3, '0');
            const sec = Number(v.slice(0, -2)) * 60 + Number(v.slice(-2));
            if (Number(v.slice(-2)) >= 60) {
              toast('秒は 0〜59 で入力してください', { kind: 'error' });
              return false;
            }
            setClock(setRemaining(clock(), sec, Date.now()));
            renderTop();
            return undefined;
          },
        },
      ],
      onClose: () => clearInterval(live),
    });
    return close;
  }

  // ---- コート ----
  function renderCourt() {
    const q = currentQuarter();
    const shots = events.filter((e) => e.type === 'fg' && e.quarter === q);
    drawShots(court.layers.shots, shots, { faded: true, highlightId: lastAddedId });
    const team = input.sel ? input.sel.team : 'us';
    drawPending(court.layers.pending, input.loc, { three: input.three, team });
  }

  // ---- 選手ボタン ----
  function oppNumberList() {
    const set = new Set(game.oppNumbers || []);
    for (const e of events) {
      if (e.team !== 'opp') continue;
      if (e.player != null) set.add(e.player);
      if (e.type === 'sub' && e.out != null) set.add(e.out);
      if (e.type === 'lineup') for (const n of e.players || []) set.add(n);
    }
    return sortNumbers([...set]);
  }

  /** チームの選手（自チームは名簿の順と呼び名、相手は背番号だけ） */
  const teamList = (team) => (team === 'us'
    ? game.roster.map((p) => ({ number: String(p.number), name: p.name || '' }))
    : oppNumberList().map((n) => ({ number: n, name: '' })));

  const nameOf = (team, number) => {
    if (team !== 'us') return '';
    const p = game.roster.find((x) => String(x.number) === String(number));
    return p ? p.name : '';
  };

  function playerButton(team, number, name, pfAll, extra = {}) {
    const pf = number == null ? 0 : pfAll[team][number] || 0;
    const selected = input.sel && input.sel.team === team && input.sel.player === number;
    const out = pf >= 5;
    const badge = pf ? h('span', { class: ['pf', `pf${Math.min(pf, 5)}`], 'aria-label': `ファウル${pf}` }, pf) : null;
    return h('button', {
      class: ['pl-btn', team, selected && 'on', out && 'out', number == null && 'nobody', extra.cls],
      type: 'button',
      'aria-disabled': out ? 'true' : null,
      'data-group': extra.group || null,
      'data-team': extra.group ? team : null,
      'data-number': number == null ? null : number,
      onclick: () => dispatch({ type: 'player', team, player: number }),
      'aria-pressed': String(!!selected),
    },
    h('span', { class: 'pl-num' }, number == null ? (team === 'us' ? 'チーム' : '番号\u200bなし') : number),
    name ? h('span', { class: 'pl-name' }, name) : null,
    badge);
  }

  function smallButton(team, label, onclick, cls = '') {
    return h('button', { class: ['pl-btn tool', team, cls], type: 'button', onclick }, h('span', { class: 'pl-tool' }, label));
  }

  /** 1チーム分の選手ボタン（コートの5人を記録していれば、上の段にコート・下の段にベンチ） */
  function sideBlock(team) {
    const pf = fouls();
    const on = courtOf(team);
    const list = teamList(team);
    const title = team === 'us' ? '自チーム' : `相手${game.opponent ? `（${game.opponent}）` : ''}`;
    const subBtn = smallButton(team, '交代', () => openSubModal(team), 'sub-btn');
    const addBtn = team === 'us' ? smallButton(team, '＋選手', addOurPlayer, 'add') : smallButton(team, '＋番号', () => addOppNumber(), 'add');
    if (on) {
      const bench = benchOf(list, on);
      return [
        h('div', { class: 'side-label' }, h('span', null, `${title}　上：コート／下：ベンチ`), h('span', { class: 'side-hint' }, 'ベンチ ⇄ コートへドラッグで交代')),
        h('div', { class: 'oncourt' },
          on.map((n) => playerButton(team, n, nameOf(team, n), pf, { group: 'court' })),
          playerButton(team, null, '', pf)),
        h('div', { class: 'bench' },
          bench.map((n) => playerButton(team, n, nameOf(team, n), pf, { group: 'bench', cls: 'benched' })),
          subBtn,
          addBtn),
      ];
    }
    return [
      h('div', { class: 'side-label' }, h('span', null, title), h('span', { class: 'side-hint' }, '「交代」でコートの5人を選ぶと、出場時間を記録します')),
      h('div', { class: team === 'us' ? 'roster-all' : 'opp-grid' },
        list.map((p) => playerButton(team, p.number, p.name, pf)),
        playerButton(team, null, '', pf),
        subBtn,
        addBtn),
    ];
  }

  function renderPlayers() {
    replace(usSide, sideBlock('us'));
    replace(oppSide, sideBlock('opp'));
    players.classList.toggle('waiting', !!(input.loc || input.action) && !input.sel);
  }

  // ---- ドラッグで交代（ベンチ ⇄ コート） ----
  let drag = null;
  let suppressClick = null; // ドラッグを離した位置と時刻（その場所の「タップ」を選手の選択にしない）
  function dragTarget(x, y) {
    const el = document.elementFromPoint(x, y);
    const btn = el && el.closest ? el.closest('.pl-btn[data-group]') : null;
    if (!btn || !drag || btn.dataset.team !== drag.team || btn.dataset.group === drag.group) return null;
    return btn;
  }
  function endDrag() {
    if (!drag) return;
    if (drag.ghost) drag.ghost.remove();
    drag.btn.classList.remove('dragging');
    players.classList.remove('drag-on', 'drag-us', 'drag-opp');
    for (const b of players.querySelectorAll('.drop-hover')) b.classList.remove('drop-hover');
    drag = null;
  }
  players.addEventListener('pointerdown', (ev) => {
    const btn = ev.target.closest('.pl-btn[data-group]');
    if (!btn || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    drag = { btn, team: btn.dataset.team, group: btn.dataset.group, number: btn.dataset.number, x: ev.clientX, y: ev.clientY, id: ev.pointerId, ghost: null };
  });
  const onMove = (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!drag.ghost) {
      if (Math.hypot(dx, dy) < 12) return;
      const r = drag.btn.getBoundingClientRect();
      drag.ghost = drag.btn.cloneNode(true);
      drag.ghost.classList.add('drag-ghost');
      Object.assign(drag.ghost.style, { width: `${r.width}px`, height: `${r.height}px` });
      document.body.appendChild(drag.ghost);
      drag.btn.classList.add('dragging');
      players.classList.add('drag-on', `drag-${drag.team}`);
    }
    drag.ghost.style.transform = `translate(${ev.clientX - drag.ghost.offsetWidth / 2}px, ${ev.clientY - drag.ghost.offsetHeight / 2}px)`;
    const target = dragTarget(ev.clientX, ev.clientY);
    for (const b of players.querySelectorAll('.drop-hover')) if (b !== target) b.classList.remove('drop-hover');
    if (target) target.classList.add('drop-hover');
  };
  const onUp = (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const moved = !!drag.ghost;
    const target = moved ? dragTarget(ev.clientX, ev.clientY) : null;
    const from = { team: drag.team, group: drag.group, number: drag.number };
    endDrag();
    if (!moved) return;
    suppressClick = { x: ev.clientX, y: ev.clientY, until: Date.now() + 500 };
    if (!target) return;
    const outNum = from.group === 'court' ? from.number : target.dataset.number;
    const inNum = from.group === 'court' ? target.dataset.number : from.number;
    recordSubs(from.team, [{ out: outNum, in: inNum }]);
  };
  const onCancel = () => endDrag();
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onCancel);
  // ドラッグのあとの「タップ」は選手の選択にしない
  players.addEventListener('click', (ev) => {
    const s = suppressClick;
    if (s && Date.now() < s.until && Math.hypot(ev.clientX - s.x, ev.clientY - s.y) < 40) {
      ev.stopPropagation();
      ev.preventDefault();
      suppressClick = null;
    }
  }, true);

  function recordSubs(team, pairs) {
    if (!pairs.length) return;
    const texts = [];
    for (const p of pairs) {
      const e = addEvent({ type: 'sub', team, player: p.in, out: p.out });
      texts.push(`#${e.out} → #${e.player}`);
    }
    // 交代で出た選手を選んでいたら外す
    if (input.sel && input.sel.team === team && pairs.some((p) => p.out === input.sel.player)) input = { ...input, sel: null };
    const text = `交代（${TEAM_TITLE(team)}）：${texts.join('、')}`;
    setMessage(text);
    toast(text);
    update();
  }

  /** コートの人数（自チームは名簿が5人未満ならその人数、相手は5人） */
  const needOnCourt = (team) => (team === 'us' ? Math.min(COURT_SIZE, game.roster.length) : COURT_SIZE);

  // ---- 交代（まとめて）／コートの5人を選ぶ ----
  function openSubModal(team = 'us') {
    const before = courtOf(team);
    if (team === 'us' && game.roster.length === 0) {
      toast('名簿に選手がいません。「＋選手」で追加してください。', { kind: 'error' });
      return;
    }
    const need = needOnCourt(team);
    let after = before ? [...before] : [];
    const pf = fouls();
    const grid = h('div', { class: ['sub-grid', team] });
    const status = h('p', { class: 'sub-status' });
    const okBtn = h('button', { class: 'btn primary', type: 'button' });
    function draw() {
      replace(grid,
        teamList(team).map((p) => {
          const n = p.number;
          const isOn = after.includes(n);
          const wasOn = before ? before.includes(n) : false;
          const f = pf[team][n] || 0;
          return h('button', {
            class: ['btn sub-choice', team, isOn && 'on', before && wasOn && !isOn && 'leaving', before && !wasOn && isOn && 'entering', f >= 5 && 'fouled'],
            type: 'button',
            'aria-pressed': String(isOn),
            onclick: () => {
              after = isOn ? after.filter((x) => x !== n) : [...after, n];
              draw();
            },
          },
          h('span', { class: 'pl-num' }, n),
          p.name ? h('span', { class: 'pl-name' }, p.name) : null,
          f ? h('span', { class: ['pf', `pf${Math.min(f, 5)}`] }, f) : null,
          h('span', { class: 'sub-mark' }, before ? (wasOn && !isOn ? 'OUT' : !wasOn && isOn ? 'IN' : '') : ''));
        }),
        team === 'opp'
          ? h('button', {
            class: 'btn sub-choice opp add', type: 'button',
            onclick: () => addOppNumber({
              then: (n) => {
                if (!after.includes(n) && (!before || after.length < need)) after = [...after, n];
                draw();
              },
            }),
          }, h('span', { class: 'pl-tool' }, '＋番号'))
          : null);
      const pairs = before ? swapPlan(before, after) : [];
      const countOk = after.length === need;
      if (!before) {
        status.textContent = countOk
          ? `コートの${need}人：${after.map((n) => `#${n}`).join('・')}`
          : `コートにいる選手を ${need} 人選んでください（いま ${after.length} 人）`;
        okBtn.textContent = '決定';
        okBtn.disabled = !countOk;
      } else {
        status.textContent = countOk
          ? pairs.length ? `交代：${pairs.map((x) => `#${x.out} → #${x.in}`).join('、')}` : '出る選手（コート）と入る選手（ベンチ）をタップしてください'
          : `コートが ${after.length} 人です。${need} 人にしてください`;
        okBtn.textContent = '交代を記録';
        okBtn.disabled = !countOk || pairs.length === 0;
      }
      status.classList.toggle('warn', !countOk);
    }
    okBtn.onclick = () => {
      if (!before) {
        addEvent({ type: 'lineup', team, players: after });
        setMessage(`出場メンバー（${TEAM_TITLE(team)}）：${after.map((n) => `#${n}`).join('・')}`);
        close();
        update();
        return;
      }
      const pairs = swapPlan(before, after);
      close();
      recordSubs(team, pairs);
    };
    draw();
    const who = team === 'us' ? '自チーム' : `相手${game.opponent ? `（${game.opponent}）` : ''}`;
    const close = modal({
      title: before ? `選手交代　${who}` : `コートにいる5人　${who}`,
      body: h('div', { class: 'sub-modal' },
        h('p', { class: 'muted' }, before
          ? '出る選手（色つき）をタップして外し、入る選手をタップして入れます。何人でもまとめて交代できます。'
          : `選んだ5人をコートに出します。以後は交代を記録すると、出場時間と +/- が集計に出ます。${team === 'opp' ? '背番号がなければ「＋番号」で足せます。' : ''}`),
        grid, status, h('div', { class: 'sub-actions' }, okBtn)),
      actions: [{ label: 'やめる' }],
      wide: true,
    });
  }

  // ---- 自チームの選手を追加（試合中） ----
  function addOurPlayer() {
    let value = '';
    const display = h('div', { class: 'keypad-display' }, '');
    const show = () => { display.textContent = value || '背番号'; display.classList.toggle('placeholder', !value); };
    show();
    const nameInput = h('input', { type: 'text', maxlength: '12', placeholder: '呼び名（あとからでも可）', 'aria-label': '呼び名', class: 'add-name' });
    const key = (k) => h('button', {
      class: 'btn keypad-key', type: 'button',
      onclick: () => {
        if (k === '←') value = value.slice(0, -1);
        else if (value.length < 2) value += k;
        show();
      },
    }, k);
    const close = modal({
      title: '自チームの選手を追加',
      body: h('div', { class: 'keypad' }, display, nameInput,
        h('div', { class: 'keypad-grid' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '←', '0'].map(key))),
      actions: [
        { label: 'やめる' },
        {
          label: '追加',
          kind: 'primary',
          onClick: () => {
            const r = addToRoster(game.roster, value, nameInput.value);
            if (r.error) {
              toast(value ? r.error : '背番号を入力してください', { kind: 'error' });
              return false;
            }
            game.roster = r.roster;
            saveGame();
            close();
            toast(`#${value} を追加しました${courtOf('us') ? '（ベンチ）' : ''}`);
            update();
            return undefined;
          },
        },
      ],
    });
  }

  // ---- 状況に応じた選択（成功／失敗、種類タグ、続きのプレー、タイムアウト、得点補正） ----
  /** 続きのプレー（アシスト・リバウンド）の行 */
  function followRow() {
    const a = input.after;
    if (!a) return null;
    const on = court5();
    const pf = fouls();
    if (a.kind === 'fg' && a.made && a.team === 'us') {
      if (!on) return null;
      const mates = on.filter((n) => n !== a.player);
      return h('div', { class: 'ctx-row follow-row' },
        h('span', { class: 'follow-label' }, 'アシスト'),
        mates.map((n) => h('button', {
          class: ['btn follow-btn us', input.assistPlayer === n && 'on'], type: 'button',
          'aria-pressed': String(input.assistPlayer === n),
          onclick: () => dispatch({ type: 'assist', player: n }),
        }, `#${n}`)));
    }
    if (a.made) return null;
    const label = (team) => (team === a.team ? 'OR' : 'DR');
    const usButtons = on
      ? on.map((n) => h('button', {
        class: ['btn follow-btn us', (pf.us[n] || 0) >= 5 && 'out'], type: 'button',
        onclick: () => dispatch({ type: 'rebound', team: 'us', player: n }),
      }, `#${n}`))
      : [h('button', { class: 'btn follow-btn us', type: 'button', onclick: () => dispatch({ type: 'rebound', team: 'us', player: null }) }, '自チーム')];
    return h('div', { class: 'ctx-row follow-row' },
      h('span', { class: 'follow-label' }, h('span', null, 'リバウンド'), h('span', { class: 'follow-sub' }, `自${label('us')}・相手${label('opp')}`)),
      usButtons,
      h('button', { class: 'btn follow-btn opp', type: 'button', onclick: () => dispatch({ type: 'rebound', team: 'opp', player: null }) }, '相手'));
  }

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
      const follow = input.tagKind === 'fg' ? followRow() : null;
      context.classList.toggle('with-follow', !!follow);
      replace(context,
        h('div', { class: 'ctx-title one-line' },
          lastMessage ? h('span', { class: 'ctx-done' }, lastMessage) : null,
          h('span', { class: 'ctx-sub' }, '種類（任意）')),
        h('div', { class: ['ctx-row', 'tag-row', input.tagKind] },
          list.map((t) => h('button', {
            class: ['btn tag-btn', input.tags.includes(t) && 'on'], type: 'button',
            'aria-pressed': String(input.tags.includes(t)),
            onclick: () => dispatch({ type: 'tag', tag: t }),
          }, TAG_BREAKS[t] || t)),
          h('button', { class: 'btn', type: 'button', onclick: () => dispatch({ type: 'cancel' }) }, '閉じる')),
        follow);
      return;
    }
    if (sheet === 'ft') {
      const a = input.after;
      const follow = followRow();
      context.classList.toggle('with-follow', !!follow);
      replace(context,
        h('div', { class: 'ctx-title one-line' },
          lastMessage ? h('span', { class: 'ctx-done' }, lastMessage) : null,
          h('span', { class: 'ctx-sub' }, `${whoLabel(a.team, a.player)} の次の1本`)),
        h('div', { class: 'ctx-row' },
          h('button', { class: 'btn made', type: 'button', onclick: () => dispatch({ type: 'ftAgain', made: true }) }, 'FT成功'),
          h('button', { class: 'btn miss', type: 'button', onclick: () => dispatch({ type: 'ftAgain', made: false }) }, 'FT失敗'),
          h('button', { class: 'btn', type: 'button', onclick: () => dispatch({ type: 'cancel' }) }, '閉じる')),
        follow);
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
    const last = events[events.length - 1];
    const afterTimeout = idle && lastMessage && last && last.type === 'timeout';
    replace(context,
      idle && lastMessage ? h('p', { class: 'ctx-done big' }, lastMessage) : null,
      afterTimeout
        ? h('a', { class: 'btn summary-link', href: summaryHref(last.quarter) }, `${quarterLabel(last.quarter)}のここまでのまとめ・AI特筆データ`)
        : h('p', { class: 'hint-text' }, hintFor(input)));
  }

  // ---- プレーボタン ----
  function renderPlays() {
    const team = input.sel ? input.sel.team : null;
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
      const disabled = US_ONLY.has(key) && team === 'opp';
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
      h('span', { class: 'log-q' }, `${quarterLabel(e.quarter)}${e.clock != null ? `　${formatClock(e.clock)}` : ''}`),
      h('span', { class: 'log-text' }, describeEvent(e, ZONE_LABELS)))));
  }

  // ---- 試合前・クォーター間 ----
  /** 試合開始前の先発の選択（自チームは名簿の先頭5人が初期値、相手は分かれば選ぶ） */
  function starterPicker(team) {
    const need = needOnCourt(team);
    const list = teamList(team);
    if (!starters[team]) starters[team] = team === 'us' ? defaultStarters(game.roster) : [];
    const picked = starters[team];
    const status = picked.length === need
      ? `先発：${picked.map((n) => `#${n}`).join('・')}`
      : team === 'us'
        ? `先発を ${need} 人選んでください（いま ${picked.length} 人）。選ばずに始めると出場時間は記録しません`
        : `分かれば ${need} 人選んでください（いま ${picked.length} 人）。あとから「交代」でも選べます`;
    return h('div', { class: ['starter-pick', team] },
      h('p', { class: 'starter-title' }, team === 'us' ? '自チームの先発' : `相手の先発${game.opponent ? `（${game.opponent}）` : ''}`),
      h('div', { class: ['starter-grid', team] },
        list.map((p) => {
          const n = p.number;
          const isOn = picked.includes(n);
          return h('button', {
            class: ['btn sub-choice', team, isOn && 'on'], type: 'button', 'aria-pressed': String(isOn),
            onclick: () => {
              starters[team] = isOn ? picked.filter((x) => x !== n) : [...picked, n];
              renderOverlay();
            },
          }, h('span', { class: 'pl-num' }, n), p.name ? h('span', { class: 'pl-name' }, p.name) : null);
        }),
        team === 'opp'
          ? h('button', {
            class: 'btn sub-choice opp add', type: 'button',
            onclick: () => addOppNumber({
              then: (n) => {
                if (!starters.opp.includes(n) && starters.opp.length < need) starters.opp = [...starters.opp, n];
                update();
              },
            }),
          }, h('span', { class: 'pl-tool' }, '＋番号'))
          : null),
      h('p', { class: ['starter-status', picked.length !== need && team === 'us' && 'warn-text'] }, status));
  }

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
    const pickUs = qs.phase === 'pre' && !courtOf('us') && game.roster.length > 0;
    const pickOpp = qs.phase === 'pre' && !courtOf('opp');
    const len = formatClock(quarterSeconds(qs.next, clockOpts()));
    const subButton = (team) => h('button', { class: ['btn', `sub-open ${team}`], type: 'button', onclick: () => openSubModal(team) },
      icon('swap'), courtOf(team) ? `${TEAM_TITLE(team)}の交代` : `${TEAM_TITLE(team)}の5人を選ぶ`);
    replace(overlay, h('div', { class: ['phase-card', (pickUs || pickOpp) && 'with-starters'] },
      qs.phase === 'pre'
        ? h('p', { class: 'phase-title' }, '試合開始前')
        : h('p', { class: 'phase-title' }, `${quarterLabel(qs.quarter)} 終了　自チーム ${score.us} − ${score.opp} 相手`),
      pickUs ? starterPicker('us') : null,
      pickOpp ? starterPicker('opp') : null,
      qs.phase === 'pre'
        ? h('p', { class: 'muted' }, `「自DF」「相手DF」を確かめて、試合が始まったら開始をタップ（時計 ${len} から動きます）。`)
        : h('p', { class: 'muted' }, `下のログをタップすると記録を修正できます。開始をタップすると時計が ${len} から動きます。`),
      h('button', { class: 'btn primary huge', type: 'button', onclick: () => startQuarter(qs.next) }, `${quarterLabel(qs.next)} 開始`),
      isEndOfRegulation ? h('p', { class: 'muted' }, '延長がない場合は、ここで記録は終わりです。') : null,
      h('div', { class: 'row center' },
        qs.phase === 'break' && game.roster.length ? subButton('us') : null,
        qs.phase === 'break' ? subButton('opp') : null,
        qs.phase === 'break' ? h('a', { class: 'btn', href: summaryHref(qs.quarter) }, `${quarterLabel(qs.quarter)}のまとめ・AI特筆データ`) : null,
        qs.phase === 'break' ? h('a', { class: 'btn', href: `#/game/${game.id}/summary` }, '集計を見る') : null,
        h('a', { class: 'btn', href: '#/' }, 'ホームへ'))));
  }

  function update() {
    renderTop();
    renderCourt();
    renderPlayers();
    renderContext();
    renderPlays();
    renderLog();
    renderOverlay();
  }

  // ---- 操作 ----
  function startQuarter(q) {
    const qs = quarterState(events);
    if (qs.phase === 'pre') {
      // 先発（選んだ人数がそろっているチームだけ）
      for (const team of ['us', 'opp']) {
        const picked = starters[team];
        if (!courtOf(team) && picked && picked.length > 0 && picked.length === needOnCourt(team)) {
          addEvent({ type: 'lineup', team, players: picked, quarter: q });
        }
      }
    }
    input = initialInput();
    // 時計をクォーターの長さに戻して動かす（試合が始まった瞬間に開始を押す）
    const now = Date.now();
    game.live.clock = startClock(newClock(q, quarterSeconds(q, clockOpts())), now);
    saveGame();
    addEvent({ type: 'q_start', team: null, quarter: q });
    setMessage(`${quarterLabel(q)} 開始`);
    toast(`${quarterLabel(q)} 開始`);
    update();
  }

  async function endQuarter() {
    const qs = quarterState(events);
    const c = clock();
    const left = c && c.quarter === qs.quarter ? remainingAt(c, Date.now()) : 0;
    const message = left >= 1
      ? `${quarterLabel(qs.quarter)}を終了しますか？（時計は残り ${formatClock(left)} です）`
      : `${quarterLabel(qs.quarter)}を終了しますか？`;
    const ok = await confirmDialog(message, { ok: '終了する', title: 'クォーター終了' });
    if (!ok) return;
    input = initialInput();
    addEvent({ type: 'q_end', team: null, quarter: qs.quarter });
    if (c && isRunning(c)) setClock(stopClock(c, Date.now()));
    update();
    // クォーター終了画面へ（保存が終わってから）
    await lastSave;
    app.go(summaryHref(qs.quarter));
  }

  function undo() {
    const last = events[events.length - 1];
    if (!last) return;
    removeEvent(last.id);
    lastAddedId = null;
    input = initialInput();
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

  /** 相手の背番号を足す。then があれば足した番号を渡す（なければ、その番号を選んだことにする） */
  function addOppNumber({ then } = {}) {
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
            if (then) {
              then(value);
              return undefined;
            }
            if (courtOf('opp')) toast(`相手#${value} をベンチに追加しました。コートに入っていれば、ドラッグで交代してください`, { ms: 4000 });
            // 追加した番号をそのまま選んだことにする（シュート・プレー待ちならそのまま記録へ）
            dispatch({ type: 'player', team: 'opp', player: value });
            return undefined;
          },
        },
      ],
    });
  }

  function openMenu() {
    const qs = quarterState(events);
    const close = modal({
      title: `vs ${game.opponent || '相手'}`,
      body: h('div', { class: 'menu-list' },
        qs.phase !== 'pre'
          ? h('a', { class: 'btn', href: summaryHref(qs.quarter), onclick: () => close() },
            `${quarterLabel(qs.quarter)}のまとめ・AI特筆データ${qs.phase === 'live' ? '（ここまで）' : ''}`)
          : null,
        h('a', { class: 'btn', href: `#/game/${game.id}/summary`, onclick: () => close() }, '集計を見る'),
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); openSubModal('us'); } }, courtOf('us') ? '選手交代（自チーム）' : 'コートにいる5人を選ぶ（自チーム）'),
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); openSubModal('opp'); } }, courtOf('opp') ? '選手交代（相手）' : 'コートにいる5人を選ぶ（相手）'),
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); addOurPlayer(); } }, '自チームの選手を追加'),
        h('a', { class: 'btn', href: `#/game/${game.id}/review`, onclick: () => close() }, '振り返り（プレー一覧・動画・チェックポイント）'),
        h('a', { class: 'btn', href: '#/qa', onclick: () => close() }, '場面別Q&A（よくある場面と対処の例）'),
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
      const parts = [h('p', { class: 'edit-desc' }, `${quarterLabel(e.quarter)}${e.clock != null ? `　残り ${formatClock(e.clock)}` : ''}　${describeEvent(e, ZONE_LABELS)}`)];
      const hasPlayer = e.team && !['timeout', 'adjust', 'q_start', 'q_end', 'sub', 'lineup'].includes(e.type);
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
      if (e.clock != null) {
        const len = quarterSeconds(e.quarter, clockOpts());
        const shift = (d) => save({ clock: Math.min(len, Math.max(0, Math.round((Number(e.clock) + d) * 10) / 10)) });
        parts.push(h('div', { class: 'edit-sec' }, h('h3', null, `時計（残り ${formatClock(e.clock)}）`),
          h('div', { class: 'choice-grid' }, [-10, -1, 1, 10].map((d) => choice(d > 0 ? `+${d}秒` : `−${-d}秒`, false, () => shift(d))))));
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
    if (!ev.target.closest('.modal, .phase-card')) ev.preventDefault();
  };
  document.addEventListener('touchmove', stopScroll, { passive: false });

  update();

  return () => {
    clearInterval(timer);
    endDrag();
    document.removeEventListener('touchmove', stopScroll);
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
  };
}

/** 長い語は決まった位置でだけ折り返す（「ターン／オーバー」） */
const TAG_BREAKS = { ジャンプシュート: 'ジャンプ\u200bシュート', セカンドチャンス: 'セカンド\u200bチャンス', オフェンスファウル: 'オフェンス\u200bファウル', 時間のバイオレーション: '時間の\u200bバイオレーション', スティールされた: 'スティール\u200bされた' };
const BREAKS = { ターンオーバー: 'ターン​オーバー', タイムアウト: 'タイム​アウト', 得点補正: '得点​補正', 選択を解除: '選択を​解除' };
function breakable(label) {
  return BREAKS[label] || label;
}
