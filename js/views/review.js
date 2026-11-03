// 振り返り画面（SPEC 6章）：プレー一覧 → 動画の該当場面へ、チェックポイント、集計・AI特筆データの再表示
import * as db from '../db.js';
import { h, replace, toast, formatDate } from '../ui.js';
import { describeEvent, quarterLabel, sortNumbers, TEAM_LABEL } from '../model.js';
import { ZONE_LABELS } from '../court.js';
import { scoreOf, maxQuarter } from '../stats.js';
import {
  PLAY_KINDS, filterPlays, videoLink, formatClock, elapsedText, evaluateTarget, mergeChecklist, MARKS,
  videoScopeLabel, DEFAULT_REWIND_SEC,
} from '../review.js';
import { videoEditor } from './video-editor.js';
import { insightRecordView, insightMetaText } from './insight-view.js';
import { quarterTable, boxSection, chartSection, teamSection } from './summary.js';

const TABS = [
  { key: 'plays', label: 'プレー一覧・動画' },
  { key: 'check', label: 'チェックポイント' },
  { key: 'ai', label: 'AI特筆データ' },
  { key: 'box', label: 'ボックススコア' },
  { key: 'chart', label: 'シュートチャート' },
  { key: 'team', label: 'チーム指標・守備隊形別' },
];

function sessionGet(k) {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}
function sessionSet(k, v) {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    // 保存できなくても動く
  }
}

export async function renderReview(root, params, app) {
  const game = await db.getGame(params.gameId);
  if (!game) {
    toast('試合が見つかりません', { kind: 'error' });
    app.go('#/');
    return;
  }
  const events = await db.listEvents(game.id);
  const names = Object.fromEntries((game.roster || []).map((p) => [String(p.number), p.name]));
  const score = scoreOf(events);
  let tab = TABS.some((t) => t.key === sessionGet('reviewTab')) ? sessionGet('reviewTab') : 'plays';

  const saveGame = async () => {
    try {
      await db.putGame(game);
    } catch (err) {
      console.error(err);
      toast('保存できませんでした', { kind: 'error' });
    }
  };

  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  const content = h('div', { class: 'review-content' });

  function drawTabs() {
    replace(tabBar, TABS.map((t) => h('button', {
      class: ['tab', tab === t.key && 'on'], type: 'button', role: 'tab', 'aria-selected': String(tab === t.key),
      onclick: () => {
        tab = t.key;
        sessionSet('reviewTab', tab);
        drawTabs();
        drawContent();
      },
    }, t.label)));
  }

  function drawContent() {
    if (tab === 'plays') replace(content, playsSection());
    else if (tab === 'check') replace(content, checkSection());
    else if (tab === 'ai') replace(content, aiSection());
    else if (tab === 'box') replace(content, h('section', { class: 'card' }, h('h2', null, 'クォーター別得点'), quarterTable(events)), boxSection(game, events));
    else if (tab === 'chart') replace(content, chartSection(game, events));
    else replace(content, teamSection(game, events, app.settings.defenses));
  }

  // ---- プレー一覧・動画 ----
  const filter = { team: 'all', player: 'all', kind: 'all', quarter: 'all', defense: 'all' };

  function playsSection() {
    const rewind = Number.isFinite(Number(app.settings.rewindSec)) ? Number(app.settings.rewindSec) : DEFAULT_REWIND_SEC;
    const videos = game.videos || [];
    const editor = videoEditor(videos, { maxQuarter: maxQuarter(events) });
    const videoError = h('p', { class: 'form-error', role: 'alert' });
    const videoCard = h('details', { class: 'card video-card', open: videos.length === 0 },
      h('summary', null,
        h('span', { class: 'vc-title' }, '動画'),
        h('span', { class: 'muted' }, videos.length
          ? `${videos.map((v) => `${videoScopeLabel(v.quarter)}（開始 ${formatClock(v.offsetSec || 0)}）`).join('、')}　巻き戻し${rewind}秒`
          : '未登録（YouTube の URL を入れると、各プレーから動画の該当場面を開けます）')),
      editor.el,
      videoError,
      h('div', { class: 'row' }, h('button', {
        class: 'btn primary', type: 'button',
        onclick: async () => {
          const r = editor.read();
          if (r.error) {
            videoError.textContent = r.error;
            return;
          }
          game.videos = r.videos;
          await saveGame();
          toast('動画を保存しました');
          drawContent();
        },
      }, '動画を保存')),
      h('p', { class: 'field-note' }, `動画の秒数 ＝ プレーを記録した時刻と開始時刻の差 ＋ 開始の位置 − ${rewind}秒（記録はプレーの後に入力するため巻き戻す。秒数は設定で変更）`));

    const list = h('div', { class: 'play-list' });
    const countEl = h('span', { class: 'muted' });
    const filters = h('div', { class: 'play-filters' });

    const select = (label, key, options) => h('label', { class: 'field' },
      h('span', { class: 'field-label' }, label),
      h('select', {
        onchange: (ev) => {
          filter[key] = ev.target.value;
          if (key === 'team') filter.player = 'all';
          drawFilters();
          drawList();
        },
      }, options.map(([v, l]) => h('option', { value: v, selected: filter[key] === v }, l))));

    function playerOptions() {
      if (filter.team === 'all') return [['all', 'すべて']];
      const nums = new Set(filter.team === 'us' ? (game.roster || []).map((p) => String(p.number)) : (game.oppNumbers || []));
      for (const e of events) if (e.team === filter.team && e.player != null) nums.add(e.player);
      const opts = [['all', 'すべて']];
      for (const n of sortNumbers([...nums])) opts.push([n, filter.team === 'us' && names[n] ? `#${n} ${names[n]}` : `#${n}`]);
      opts.push(['none', filter.team === 'us' ? 'チーム（選手なし）' : '番号なし']);
      return opts;
    }
    function quarterOptions() {
      const qs = [...new Set(events.map((e) => e.quarter).filter(Boolean))].sort((a, b) => a - b);
      return [['all', 'すべて'], ['H1', '前半'], ['H2', '後半'], ...qs.map((q) => [String(q), quarterLabel(q)])];
    }
    function defenseOptions() {
      const ds = [...new Set(events.filter((e) => e.defense).map((e) => e.defense))];
      return [['all', 'すべて'], ...ds.map((d) => [d, d])];
    }
    function drawFilters() {
      replace(filters,
        select('チーム', 'team', [['all', 'すべて'], ['us', '自チーム'], ['opp', '相手']]),
        select('選手', 'player', playerOptions()),
        select('種類', 'kind', PLAY_KINDS.map((k) => [k.key, k.label])),
        select('クォーター', 'quarter', quarterOptions()),
        select('守備隊形', 'defense', defenseOptions()));
    }
    function drawList() {
      const plays = filterPlays(events, filter);
      countEl.textContent = `${plays.length}件`;
      if (!plays.length) {
        replace(list, h('p', { class: 'muted empty-list' }, '当てはまるプレーがありません'));
        return;
      }
      replace(list, plays.map((e) => {
        const link = videoLink(e, events, game.videos || [], rewind);
        const name = e.team === 'us' && e.player != null && names[e.player] ? names[e.player] : '';
        return h('div', { class: ['play-row', e.team || 'none'] },
          h('span', { class: 'pr-q' }, quarterLabel(e.quarter)),
          h('span', { class: 'pr-time' }, elapsedText(e, events)),
          h('span', { class: 'pr-desc' }, describeEvent(e, ZONE_LABELS), name ? h('span', { class: 'pr-name' }, name) : null),
          h('span', { class: 'pr-def' }, e.defense ? `守備：${e.defense}` : ''),
          link
            ? h('a', { class: 'btn small pr-video', href: link.url, target: '_blank', rel: 'noopener', 'aria-label': `動画の ${formatClock(link.sec)} から再生` }, `▶ ${formatClock(link.sec)}`)
            : h('span', { class: 'pr-novideo' }, '動画なし'));
      }));
    }
    drawFilters();
    drawList();

    return h('div', null,
      videoCard,
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'プレー一覧'), countEl),
        filters,
        list));
  }

  // ---- チェックポイント ----
  function checkSection() {
    const template = app.settings.checklistTemplate || [];
    const merged = mergeChecklist(game.checklist || [], template);
    let items = merged.items;
    const body = h('div', { class: 'check-list' });
    const summaryEl = h('p', { class: 'check-summary' });
    let memoTimer = null;

    const persist = async () => {
      game.checklist = items.map((it) => ({ itemId: it.itemId, label: it.label, target: it.target || null, mark: it.mark || null, memo: it.memo || '' }));
      await saveGame();
    };

    function markOf(it) {
      return it.target ? evaluateTarget(it.target, events).mark : it.mark;
    }

    function drawSummary() {
      const counts = { '◯': 0, '△': 0, '×': 0 };
      for (const it of items) {
        const m = markOf(it);
        if (counts[m] != null) counts[m] += 1;
      }
      summaryEl.textContent = `◯ ${counts['◯']}　△ ${counts['△']}　× ${counts['×']}　未評価 ${items.length - counts['◯'] - counts['△'] - counts['×']}`;
    }

    function drawItems() {
      replace(body, items.map((it, i) => {
        const auto = it.target ? evaluateTarget(it.target, events) : null;
        const memo = h('input', {
          type: 'text', class: 'check-memo', value: it.memo || '', placeholder: 'メモ', maxlength: '200', 'aria-label': `${it.label}のメモ`,
          oninput: (ev) => {
            items[i].memo = ev.target.value;
            clearTimeout(memoTimer);
            memoTimer = setTimeout(persist, 600);
          },
        });
        return h('div', { class: 'check-item' },
          h('div', { class: 'check-head' },
            h('span', { class: 'check-label' }, it.label),
            auto
              ? h('span', { class: ['auto-mark', auto.ok === true ? 'ok' : auto.ok === false ? 'ng' : 'na'] }, auto.mark || '—')
              : h('div', { class: 'mark-buttons', role: 'group', 'aria-label': `${it.label}の評価` }, MARKS.map((m) => h('button', {
                class: ['btn mark-btn', it.mark === m && 'on'], type: 'button', 'aria-pressed': String(it.mark === m),
                onclick: async () => {
                  items[i].mark = it.mark === m ? null : m;
                  await persist();
                  drawItems();
                  drawSummary();
                },
              }, m)))),
          auto ? h('p', { class: 'check-auto' }, auto.text, '（試合の数字から自動で判定）') : null,
          memo);
      }));
    }

    if (!items.length) {
      return h('section', { class: 'card' },
        h('h2', null, 'チェックポイント'),
        h('p', null, (app.settings.checklistTemplate || []).length
          ? '対象のチェック項目がありません。「設定」→「チェック項目」で、この振り返りで使う項目の「対象」にチェックを入れます。'
          : 'チェック項目がありません。「設定」→「チェック項目」で作ります（項目は主顧問と相談して決める前提です）。'),
        h('a', { class: 'btn', href: '#/settings' }, '設定を開く'));
    }
    drawItems();
    drawSummary();
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'チェックポイント'), summaryEl),
      merged.missing.length
        ? h('div', { class: 'notice small-notice' },
          `設定で対象にした項目のうち、この試合にない項目が ${merged.missing.length}件あります。`,
          h('button', {
            class: 'btn small', type: 'button',
            onclick: async () => {
              items = [...items, ...merged.missing.map((t) => ({ itemId: t.id, label: t.label, target: t.target || null, mark: null, memo: '' }))];
              await persist();
              drawContent();
            },
          }, '追加する'))
        : null,
      body,
      h('p', { class: 'field-note' }, '◯／△／× はもう一度押すと外れます。目標値のある項目は試合の数字から自動で ◯／× を出します。評価とメモはこの試合に保存されます。'));
  }

  // ---- AI特筆データ（保存した結果の再表示） ----
  function aiSection() {
    const records = [...(game.insights || [])].sort((a, b) => a.quarter - b.quarter || b.createdAt - a.createdAt);
    if (!records.length) {
      return h('section', { class: 'card' },
        h('h2', null, 'AI特筆データ'),
        h('p', { class: 'muted' }, 'まだありません。記録画面の「クォーター終了」の後に出る画面で「AI特筆データ」を押すと、ここに残ります。'));
    }
    const byQuarter = new Map();
    for (const r of records) {
      if (!byQuarter.has(r.quarter)) byQuarter.set(r.quarter, []);
      byQuarter.get(r.quarter).push(r);
    }
    return h('div', null, [...byQuarter.entries()].map(([q, list]) => h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', null, `${quarterLabel(q)}${q === 2 ? '（ハーフタイム）' : ''}`),
        h('a', { class: 'btn small', href: `#/game/${game.id}/quarter/${q}` }, 'クォーター終了画面を開く')),
      insightRecordView(list[0], names),
      list.length > 1
        ? h('details', { class: 'ai-history' },
          h('summary', null, `前の結果（${list.length - 1}件）`),
          list.slice(1).map((r) => h('div', { class: 'history-item' },
            h('p', { class: 'insight-meta' }, insightMetaText(r), r.source === 'ai' ? ' AI' : '（自動抽出・AIなし）'),
            h('ul', null, r.items.map((it) => h('li', null, it.line))))))
        : null)));
  }

  root.append(
    h('header', { class: 'page-head' },
      h('a', { class: 'btn', href: '#/' }, 'ホーム'),
      h('div', { class: 'head-title' },
        h('h1', null, `振り返り　vs ${game.opponent || '相手'}`),
        h('span', { class: 'muted' }, `${formatDate(game.date)} ${game.tournament || ''}　${TEAM_LABEL.us} ${score.us} − ${score.opp} ${TEAM_LABEL.opp}`)),
      h('div', { class: 'head-actions' },
        h('a', { class: 'btn', href: `#/game/${game.id}/record` }, '記録へ'))),
    h('div', { class: 'page wide' }, tabBar, content),
  );
  drawTabs();
  drawContent();
}
