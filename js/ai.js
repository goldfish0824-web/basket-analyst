// AI特筆データの問い合わせ（Cloudflare Worker の POST /basket/insight へ）。
// 10秒で応答がない・通信できない・未設定のときは呼び出し側が端末内の順位付けに切り替える。

export const AI_TIMEOUT_MS = 10000;
export const INSIGHT_PATH = '/basket/insight';

export const REASON_TEXT = {
  not_configured: 'AI未設定',
  bad_url: 'Worker の URL が正しくありません',
  offline: '通信できません',
  network: '通信できません',
  timeout: '10秒で応答がありません',
  unauthorized: 'スタッフ用パスコードが違います',
  forbidden: 'この URL からの接続が Worker で許可されていません',
  http: 'AIの中継でエラーが起きました',
  bad_response: 'AIの応答を読めません',
  empty: 'AIの応答に使える行がありません',
};

/** 入力された Worker の URL から問い合わせ先を作る（末尾に /basket/insight を付ける） */
export function insightEndpoint(base) {
  const s = String(base || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  return s.endsWith(INSIGHT_PATH) ? s : `${s}${INSIGHT_PATH}`;
}

export function isConfigured(settings) {
  return !!(settings && settings.workerUrl && settings.staffPass);
}

/**
 * 問い合わせる。戻り値は { ok: true, data } か { ok: false, reason, status? }。
 * opts = { timeoutMs, fetchImpl, online }
 */
export async function requestInsights(settings, payload, opts = {}) {
  const { timeoutMs = AI_TIMEOUT_MS, fetchImpl = globalThis.fetch, online = true } = opts;
  if (!isConfigured(settings)) return { ok: false, reason: 'not_configured' };
  const url = insightEndpoint(settings.workerUrl);
  if (!url) return { ok: false, reason: 'bad_url' };
  if (!online) return { ok: false, reason: 'offline' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Staff-Pass': settings.staffPass },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (res.status === 401) return { ok: false, reason: 'unauthorized', status: 401 };
    if (res.status === 403) return { ok: false, reason: 'forbidden', status: 403 };
    if (!res.ok) return { ok: false, reason: 'http', status: res.status };
    let data;
    try {
      data = await res.json();
    } catch {
      if (ctrl.signal.aborted) return { ok: false, reason: 'timeout' };
      return { ok: false, reason: 'bad_response' };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, reason: ctrl.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** 接続テスト：候補0件で送る（Worker は AI を呼ばずに空の結果を返す） */
export function testConnection(settings, opts) {
  return requestInsights(
    settings,
    { kind: 'quarter_insight', quarterEnded: 0, isHalftime: false, score: { us: 0, opp: 0, byQuarter: { us: [], opp: [] } }, candidates: [] },
    opts,
  );
}

export function reasonText(r) {
  if (!r || r.ok) return '';
  const base = REASON_TEXT[r.reason] || '通信できません';
  return r.status && r.reason === 'http' ? `${base}（${r.status}）` : base;
}
