// クォーター終了画面（SPEC 5-2）：そのクォーターと累計のスコア、チームファウル、ファウルトラブルの選手、AI特筆データ
// タイムアウト中（クォーターの途中）にも同じ画面で、その時点までの数字を出す。
import { canUseAi } from '../sync-core.js';
import * as db from '../db.js';
import { h, replace, toast, formatDate, icon } from '../ui.js';
import { quarterState, quarterLabel, uuid } from '../model.js';
import { scoreOf, scoreByQuarter, teamFouls } from '../stats.js';
import {
  buildCandidates, buildPayload, acceptAiResponse, pickLocal, localLine, evidenceText, CATEGORY_LABEL,
} from '../insights.js';
import { requestInsights, requestAdvice, reasonText, isConfigured } from '../ai.js';
import { buildAdvicePayload, acceptAdvice, relatedQaFor, mergeRelated, MAX_QUESTION } from '../advice.js';
import { QA_ITEMS } from '../qa.js';
import { insightRecordView, insightMetaText } from './insight-view.js';

const QA_LIST = QA_ITEMS.map((it) => ({ id: it.id, title: it.title }));
const QA_IDS = QA_LIST.map((x) => x.id);
const QA_TITLE = Object.fromEntries(QA_LIST.map((x) => [x.id, x.title]));

export async function renderQuarter(root, params, app) {
  const game = await db.getGame(params.gameId);
  if (!game) {
    toast('試合が見つかりません', { kind: 'error' });
    app.go('#/');
    return;
  }
  const events = await db.listEvents(game.id);
  const qs = quarterState(events);
  const q = Number(params.quarter);
  if (!q || qs.phase === 'pre' || q > qs.quarter) {
    app.go(`#/game/${game.id}/record`);
    return;
  }
  const inProgress = qs.phase === 'live' && q === qs.quarter;
  const isHalftime = q === 2 && !inProgress;
  const ev = events.filter((e) => e.quarter && e.quarter <= q);
  const names = Object.fromEntries((game.roster || []).map((p) => [String(p.number), p.name]));
  const candidates = buildCandidates(events, { quarter: q, inProgress, exclude: app.settings.aiExclude });
  const ql = quarterLabel(q);
  const title = inProgress ? `${ql} 途中のまとめ` : `${ql} 終了${isHalftime ? '（ハーフタイム）' : ''}`;

  // ---- スコア・ファウル ----
  const byQ = scoreByQuarter(ev);
  const total = scoreOf(ev);
  const tf = teamFouls(ev, q);
  const fouls = candidates
    .filter((c) => c.category === 'foul_trouble' || c.category === 'opp_foul_trouble')
    .sort((a, b) => b.value - a.value || (a.team === 'us' ? -1 : 1));

  const scoreRow = (label, us, opp, big) =>
    h('div', { class: ['qs-row', big && 'big'] },
      h('span', { class: 'qs-label' }, label),
      h('span', { class: 'qs-num us' }, us),
      h('span', { class: 'qs-sep' }, '−'),
      h('span', { class: 'qs-num opp' }, opp));

  const scoreCard = h('section', { class: 'card q-score' },
    h('div', { class: 'qs-teams' }, h('span', null, '自チーム'), h('span', null, game.opponent || '相手')),
    scoreRow(inProgress ? `${ql}（ここまで）` : ql, byQ.us[q - 1], byQ.opp[q - 1], true),
    scoreRow('累計', total.us, total.opp, false),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'stats quarter-table' },
        h('thead', null, h('tr', null, h('th', null, ''), byQ.quarters.slice(0, q).map((n) => h('th', null, quarterLabel(n))), h('th', null, '計'))),
        h('tbody', null,
          h('tr', { class: 'us' }, h('th', null, '自チーム'), byQ.us.slice(0, q).map((v) => h('td', null, v)), h('td', null, total.us)),
          h('tr', { class: 'opp' }, h('th', null, '相手'), byQ.opp.slice(0, q).map((v) => h('td', null, v)), h('td', null, total.opp))))),
    h('h3', null, `チームファウル（${q > 4 ? '4Q以降' : ql}）`),
    h('div', { class: 'q-tf' },
      h('span', { class: ['tf-val', tf.us >= 5 && 'over'] }, `自チーム ${tf.us}`),
      h('span', { class: ['tf-val', tf.opp >= 5 && 'over'] }, `相手 ${tf.opp}`)),
    h('h3', null, 'ファウルトラブル'),
    fouls.length
      ? h('ul', { class: 'q-fouls' }, fouls.map((c) => h('li', { class: c.team },
        h('span', { class: ['pf', `pf${Math.min(c.value, 5)}`] }, c.value),
        h('span', null, c.subject, c.team === 'us' && names[c.player] ? ` ${names[c.player]}` : ''))))
      : h('p', { class: 'muted' }, 'なし'),
    h('p', { class: 'field-note' }, '前半は2以上、3Q終了時は3以上、4以上はいつでも表示'));

  // ---- AI特筆データ ----
  const statusEl = h('p', { class: 'ai-status', 'aria-live': 'polite' });
  const resultEl = h('div', { class: 'ai-result' });
  const historyEl = h('div', { class: 'ai-history' });
  const runBtn = h('button', { class: 'btn primary big ai-run', type: 'button', onclick: run, disabled: candidates.length === 0 }, icon('sparkle'), h('span', { class: 'ai-run-label' }, 'AI特筆データ'));

  function savedForQuarter() {
    return (game.insights || []).filter((r) => r.quarter === q).sort((a, b) => b.createdAt - a.createdAt);
  }

  function drawResult(record) {
    if (!record) {
      replace(resultEl, candidates.length
        ? h('p', { class: 'muted' }, isConfigured(app.settings)
          ? '「AI特筆データ」を押すと、候補から最大3つを選んで表示します。'
          : 'AIが未設定です。押すと端末内の順位付けで上位3つを表示します（設定でAI接続を入れるとAIが選びます）。')
        : h('p', { class: 'muted' }, '特筆する候補がありません（条件を満たす数字がまだありません）。'));
      return;
    }
    replace(resultEl, insightRecordView(record, names, { onAsk: (it) => ask({ item: it }) }));
  }

  function drawHistory() {
    const list = savedForQuarter().slice(1);
    if (!list.length) {
      replace(historyEl);
      return;
    }
    replace(historyEl, h('details', null,
      h('summary', null, `この${inProgress ? '時点' : 'クォーター'}の前の結果（${list.length}件）`),
      list.map((r) => h('div', { class: 'history-item' },
        h('p', { class: 'insight-meta' }, insightMetaText(r), r.source === 'ai' ? ' AI' : '（自動抽出・AIなし）'),
        h('ul', null, r.items.map((it) => h('li', null, it.line)))))));
  }

  // ---- 対処の例（AIに聞く） ----
  const adviceStatus = h('p', { class: 'ai-status', 'aria-live': 'polite' });
  const adviceList = h('div', { class: 'advice-list' });
  const questionInput = h('input', {
    type: 'text', class: 'advice-input', maxlength: String(MAX_QUESTION), enterkeyhint: 'send',
    placeholder: '例：相手#4のゴール下のシュートを減らすには？', 'aria-label': 'AIに聞きたいこと',
  });
  const askBtn = h('button', { class: 'btn primary advice-send', type: 'submit' }, icon('sparkle'), 'AIに聞く');
  const askForm = h('form', {
    class: 'advice-form',
    onsubmit: (ev) => {
      ev.preventDefault();
      const text = questionInput.value.trim();
      if (!text) {
        questionInput.focus();
        return;
      }
      ask({ question: text });
    },
  }, questionInput, askBtn);
  const adviceCard = h('section', { class: 'card q-advice' },
    h('div', { class: 'card-head' }, h('h2', null, '対処の例（AIに聞く）')),
    h('p', { class: 'advice-note' }, 'AIが出す「対処の例」です。決めるのはコーチです。特筆データの各行や、候補の一覧（すべての候補）の「対処の例を聞く」か、下の欄から聞けます。'),
    askForm,
    adviceStatus,
    adviceList);

  function adviceForQuarter() {
    return (game.advice || []).filter((r) => r.quarter === q).sort((a, b) => b.createdAt - a.createdAt);
  }

  function adviceView(r) {
    return h('div', { class: 'advice-record' },
      h('p', { class: 'advice-q' },
        h('span', { class: ['advice-tag', r.insightLine ? 'insight' : 'question'] }, r.insightLine ? (r.fromCandidate ? '候補' : '特筆データ') : '質問'),
        r.insightLine || r.question),
      r.insightLine && r.question ? h('p', { class: 'advice-q2' }, r.question) : null,
      h('p', { class: 'insight-meta' }, insightMetaText(r), r.source === 'ai' ? h('span', { class: 'src ai' }, 'AIの対処の例') : null),
      r.options.length
        ? h('ol', { class: 'advice-options' }, r.options.map((o) => h('li', null,
          h('p', { class: 'advice-label' }, o.label),
          h('p', { class: 'advice-detail' }, o.detail))))
        : h('p', { class: 'advice-none' }, r.note ? `AIに聞けませんでした（${r.note}）。` : 'AIから対処の例が返ってきませんでした。'),
      r.related.length
        ? h('div', { class: 'advice-related' },
          h('span', { class: 'advice-related-h' }, '関連する場面別Q&A'),
          r.related.filter((id) => QA_TITLE[id]).map((id) => h('a', { class: 'btn advice-qa', href: `#/qa/${id}` }, icon('book'), QA_TITLE[id])))
        : null);
  }

  function drawAdvice() {
    const list = adviceForQuarter();
    if (!list.length) {
      replace(adviceList);
      return;
    }
    const [latest, ...older] = list;
    replace(adviceList,
      adviceView(latest),
      older.length
        ? h('details', { class: 'advice-older' },
          h('summary', null, `この${inProgress ? '時点' : 'クォーター'}の前に聞いたこと（${older.length}件）`),
          older.map(adviceView))
        : null);
  }

  let asking = false;
  async function ask({ item = null, question = '' }) {
    if (asking) return;
    asking = true;
    askBtn.disabled = true;
    adviceCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const configured = isConfigured(app.settings);
    adviceStatus.textContent = configured ? 'AIに問い合わせ中…（最大20秒）' : '';
    const local = item ? relatedQaFor(item.candidate) : [];
    let options = [];
    let aiRelated = [];
    let note = '';
    const payload = buildAdvicePayload({ events, quarter: q, inProgress, item, question, qa: QA_LIST, exclude: app.settings.aiExclude });
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    const r = await requestAdvice(app.settings, payload, { online });
    if (r.ok) {
      ({ options, related: aiRelated } = acceptAdvice(r.data, QA_IDS));
      if (!options.length) note = 'AIの応答に使える対処の例がありません';
    } else {
      note = r.reason === 'timeout' ? '20秒で応答がありません' : reasonText(r);
    }
    const record = {
      id: uuid(), quarter: q, inProgress, createdAt: Date.now(),
      source: options.length ? 'ai' : 'none', note,
      insightLine: item ? item.line : '', candidateId: item ? item.candidateId : null, fromCandidate: !!(item && item.fromCandidate),
      question: payload.question, options, related: mergeRelated(aiRelated, local, QA_IDS),
    };
    game.advice = [...(game.advice || []), record];
    try {
      await db.putGame(game);
    } catch (err) {
      console.error(err);
      toast('結果を保存できませんでした', { kind: 'error' });
    }
    if (question && options.length) questionInput.value = '';
    adviceStatus.textContent = '';
    askBtn.disabled = false;
    asking = false;
    drawAdvice();
  }

  async function run() {
    runBtn.disabled = true;
    statusEl.textContent = isConfigured(app.settings) ? 'AIに問い合わせ中…（最大10秒）' : '';
    const payload = buildPayload({ events, quarter: q, inProgress, candidates });
    const sentIds = new Set(payload.candidates.map((c) => c.id));
    const sent = candidates.filter((c) => sentIds.has(c.id));
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    const r = await requestInsights(app.settings, payload, { online });
    let items = [];
    let note = '';
    if (r.ok) {
      items = acceptAiResponse(r.data, sent);
      if (!items.length) note = 'AIの応答に使える行がありません';
    } else {
      note = reasonText(r);
    }
    let source = 'ai';
    if (!items.length) {
      source = 'local';
      items = pickLocal(candidates).map((c) => ({ candidateId: c.id, line: localLine(c), candidate: c }));
    }
    const record = { id: uuid(), quarter: q, isHalftime, inProgress, createdAt: Date.now(), source, note, items };
    game.insights = [...(game.insights || []), record];
    try {
      await db.putGame(game);
    } catch (err) {
      console.error(err);
      toast('結果を保存できませんでした', { kind: 'error' });
    }
    statusEl.textContent = '';
    runBtn.querySelector('.ai-run-label').textContent = 'もう一度（AI特筆データ）';
    runBtn.disabled = false;
    drawResult(record);
    drawHistory();
  }

  const latest = savedForQuarter()[0];
  if (latest) runBtn.querySelector('.ai-run-label').textContent = 'もう一度（AI特筆データ）';
  drawResult(latest);
  drawHistory();
  drawAdvice();

  // 候補はすべて「対処の例を聞く」ができる（AI が選んだ3つ以外も）
  const candidateList = h('details', { class: 'cand-list' },
    h('summary', null, `候補 ${candidates.length}件（端末で計算した数字。AIはこの中から選びます。各行から対処の例を聞けます）`),
    h('ol', null, candidates.map((c) => h('li', { class: 'cand-row' },
      // ボタンは右に寄せる（先に置いて回り込ませる）
      h('button', {
        class: 'btn small cand-ask', type: 'button', 'aria-label': `対処の例を聞く：${localLine(c)}`,
        onclick: () => ask({ item: { candidateId: c.id, line: localLine(c), candidate: c, fromCandidate: true } }),
      }, icon('sparkle'), '対処の例を聞く'),
      h('div', { class: 'cand-text' },
        h('span', { class: 'cand-line' }, localLine(c)),
        h('span', { class: 'cand-meta' }, `${evidenceText(c, names)}　${CATEGORY_LABEL[c.category]}　点数 ${c.localScore.toFixed(2)}`))))));

  root.append(
    h('header', { class: 'page-head' },
      h('a', { class: 'btn', href: `#/game/${game.id}/record` }, icon('back'), '記録へ'),
      h('div', { class: 'head-title' },
        h('h1', null, title),
        h('span', { class: 'muted' }, `vs ${game.opponent || '相手'}　${formatDate(game.date)}`)),
      h('div', { class: 'head-actions' }, h('a', { class: 'btn', href: `#/game/${game.id}/summary` }, icon('chart'), '集計'))),
    h('div', { class: 'page wide quarter-page' },
      scoreCard,
      // AI特筆データ・対処の例は管理者だけ（ログインしていない自分の端末も見られる）
      canUseAi(app.settings)
        ? h('div', { class: 'q-col' },
          h('section', { class: 'card q-ai' },
            h('div', { class: 'card-head' }, h('h2', null, 'AI特筆データ'), runBtn),
            statusEl,
            resultEl,
            historyEl,
            candidateList,
            h('p', { class: 'field-note' }, '数字はすべて端末で計算しています。AIには背番号と数字だけを送り、選手の名前は送りません。')),
          adviceCard)
        : h('div', { class: 'q-col' },
          h('section', { class: 'card' }, h('p', { class: 'muted' }, 'AI特筆データと対処の例は、管理者だけが見られます。')))),
  );
}
