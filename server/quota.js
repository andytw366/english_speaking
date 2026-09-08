// 每天最多可以呼叫幾次要花錢的服務。**純邏輯** —— 不碰檔案、不碰 express，
// 所以 `test/quota.test.js` 測得到（計數的落地在 `server/store.js`）。
//
// ─── 為什麼需要它 ────────────────────────────────────────────────────────
//
// 加了情境對話的 AI 修正之後，這個 App 第一次有了「**打字就花錢**」的地方。
// 跟讀還算得出上限（一句一次錄音，人手速有極限），但對話是每按一次「對答案」
// 就一次呼叫，而按錯、手殘連按、或是把某個模式開著讓它一直重試，
// 帳單上看到的時候已經來不及了。
//
// ─── 一個預算，不是每個模式各一個 ────────────────────────────────────────
//
// 上限是**所有模式加在一起**算的：跟讀的中文講評、情境對話的 AI 修正、
// Azure 的發音評估，全部記在同一個計數裡。
//
// 為什麼不每個模式各給一個額度：花的錢是同一個帳戶的。「對話還有 30 次、
// 跟讀只剩 2 次」這種狀態沒有辦法解釋 —— 使用者在意的是「我今天還能練多少」，
// 而不是「我在哪個分頁裡還能練多少」。
//
// ─── 不同的模型可以有不同的上限 ──────────────────────────────────────────
//
// 但**同一個預算裡，各個模型還可以再有自己的上限**，因為它們的價錢與配額
// 差好幾個數量級：Gemini 免費層是每分鐘／每日的請求數，HF 的 Inference
// Providers 是按 token 計費，Azure 免費層是每月 5 小時音訊。
// 所以「便宜的那個多給一點、貴的那個少給一點」是真的需求，而寫成
//
//   AI_DAILY_LIMIT=200
//   AI_DAILY_LIMITS=gemini=50; openai/gpt-oss-120b:groq=500; azure=off
//
// 就是「全部加起來每天 200 次，其中 Gemini 最多 50 次，那個 HF 的 model
// 最多 500 次（但總量還是 200 擋著），Azure 不另外限制」。
// **兩道都要過**：總量與該模型各自的上限，任一個滿了就擋。

/** 沒設定時的每日總上限。 */
export const DEFAULT_DAILY_LIMIT = 200;

/** 「不限制」可以怎麼寫。`0` 也算 —— 「0 次」當成上限的話整個 App 直接不能用。 */
const UNLIMITED_WORDS = ['off', 'none', 'no', 'false', 'unlimited', '-1', '0', '不限', '無'];

/**
 * 一個上限值。`null` 代表**不限制**，數字代表每天最多幾次。
 * 看不懂的值一律回 `undefined`（呼叫端會退回預設值並警告）——
 * 打錯字時寧可用預設值，也不要靜靜地變成「不限制」。
 */
export function parseLimit(raw) {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (value === '') return undefined;
  if (UNLIMITED_WORDS.includes(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

/**
 * 逐模型的上限。`gemini=50; azure=off` → `{ gemini: 50, azure: null }`。
 *
 * 分隔符號同時收 `;` 與 `,` 與換行：model id 裡不會有這三個字元，
 * 而「我照著文件打卻沒生效」比多支援兩個符號麻煩得多。
 */
export function parseLimits(raw) {
  const out = {};
  if (typeof raw !== 'string') return out;

  for (const piece of raw.split(/[;,\n]/)) {
    const text = piece.trim();
    if (!text) continue;
    // model id 裡有 `/` 與 `:`，但不會有 `=` —— 用第一個 `=` 切
    const at = text.indexOf('=');
    if (at <= 0) {
      console.warn(`[quota] AI_DAILY_LIMITS 的「${text}」看不懂，要寫成 model=次數，已略過`);
      continue;
    }
    const key = text.slice(0, at).trim();
    const limit = parseLimit(text.slice(at + 1));
    if (limit === undefined) {
      console.warn(`[quota] AI_DAILY_LIMITS 裡「${key}」的次數看不懂，已略過`);
      continue;
    }
    out[key] = limit;
  }
  return out;
}

/**
 * 現在的上限設定。每次呼叫都重讀 `process.env` ——
 * 從設定頁存的值是寫進 `settings.env` 再 `dotenv.override`，
 * 快取起來的話「在網頁上改了上限卻沒有反應」。
 *
 * @returns {{total: number|null, byKey: Record<string, number|null>}}
 */
export function limitsFromEnv(env = process.env) {
  const parsed = parseLimit(env.AI_DAILY_LIMIT);
  if (parsed === undefined && env.AI_DAILY_LIMIT?.trim()) {
    console.warn(
      `[quota] AI_DAILY_LIMIT="${env.AI_DAILY_LIMIT}" 看不懂，改用預設值 ${DEFAULT_DAILY_LIMIT}。` +
        '可以填數字，或 off 表示不限制。'
    );
  }
  return {
    total: parsed === undefined ? DEFAULT_DAILY_LIMIT : parsed,
    byKey: parseLimits(env.AI_DAILY_LIMITS),
  };
}

/**
 * 一次呼叫記在哪個計數上。
 *
 * 用**模型 id**當鍵而不是模式名稱，因為上限是跟著「誰在收錢」走的：
 * 同一個 model 被跟讀與情境對話用到時，那是同一個配額。
 *
 * @param {{provider?: string, model?: string}} call
 */
export function usageKey({ provider, model } = {}) {
  const id = String(model ?? '').trim();
  if (id) return id;
  const who = String(provider ?? '').trim();
  return who || 'unknown';
}

/**
 * 這一次呼叫放不放行。**純函式** —— 吃「今天已經用掉的計數」與上限設定。
 *
 * @param {{usage?: {total?: number, byKey?: Record<string, number>},
 *   key: string, provider?: string,
 *   limits?: {total: number|null, byKey: Record<string, number|null>}}} input
 * @returns {{allowed: boolean, reason: 'total'|'key'|null,
 *   total: number, totalLimit: number|null,
 *   used: number, limit: number|null, remaining: number|null}}
 *   remaining 是「總量還剩幾次」與「這個模型還剩幾次」取小的那個；
 *   兩邊都不限制時是 null（畫面上就不寫剩幾次）
 */
export function judgeCall({ usage = {}, key, provider, limits = { total: null, byKey: {} } }) {
  const total = Number(usage.total ?? 0);
  const used = Number(usage.byKey?.[key] ?? 0);

  // 逐模型的上限先找完整的 model id，找不到再找供應商名稱 ——
  // 這樣 `AI_DAILY_LIMITS=gemini=50` 對所有 Gemini 的 model 都成立，
  // 不必把白名單裡每一個 model 都列一次
  const byKey = limits.byKey ?? {};
  const limit = key in byKey
    ? byKey[key]
    : (provider && provider in byKey ? byKey[provider] : null);

  const totalLimit = limits.total ?? null;
  const left = [
    totalLimit === null ? null : totalLimit - total,
    limit === null ? null : limit - used,
  ].filter((n) => n !== null);
  const remaining = left.length ? Math.max(0, Math.min(...left)) : null;

  if (totalLimit !== null && total >= totalLimit) {
    return { allowed: false, reason: 'total', total, totalLimit, used, limit, remaining: 0 };
  }
  if (limit !== null && used >= limit) {
    return { allowed: false, reason: 'key', total, totalLimit, used, limit, remaining: 0 };
  }
  return { allowed: true, reason: null, total, totalLimit, used, limit, remaining };
}

/**
 * 擋下來時給使用者看的中文。
 *
 * 兩種原因要講不同的話：總量滿了是「今天練夠了（或設定太小）」，
 * 某個模型滿了是「換一個模型還能繼續」—— 混成一句的話，
 * 使用者不知道自己還有沒有路可以走。
 */
export function describeBlock(verdict, { what = 'AI 功能' } = {}) {
  if (verdict.reason === 'total') {
    return `今天的呼叫次數已經用完了（上限 ${verdict.totalLimit} 次，所有模式一起算）。` +
      '明天會重新計算；要調整請到「設定 → 每天的呼叫上限」（要擁有者的帳號）。';
  }
  return `這個模型今天的次數已經用完了（上限 ${verdict.limit} 次）。` +
    `${what}要繼續用的話，可以換一個模型，或到「設定 → 每天的呼叫上限」調整` +
    '（要擁有者的帳號）。';
}
