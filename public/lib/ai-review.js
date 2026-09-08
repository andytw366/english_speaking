// 情境對話的 AI 修正，前端這一半：問伺服器「這個功能現在能不能用」，
// 以及送一句話去要一次修正。
//
// 為什麼獨立成一個檔案而不是塞在 modes/dialogue.js 裡：
//   1. 「能不能用」要**跨模式共用一份快取**。這一趟是打 /api/capabilities，
//      而設定頁也在打同一支 —— 每換一段對話就重新問一次是純粹的浪費；
//   2. 這裡有一個很容易寫錯的地方：**請求飛在半路時使用者已經按了「繼續對話」**。
//      沒有處理的話，上一句的修正會蓋在下一句的畫面上，而那個 bug 只有手速快
//      的時候才出現。`token` 那一段就是在擋這件事，抽出來才講得清楚。
//
// 金鑰一律不進瀏覽器 —— 這裡只送文字，模型是伺服器呼叫的（見 server/settings.js）。

/**
 * 「這台伺服器現在有沒有一條可以呼叫的模型」。
 *
 * 整個 App 共用一個 promise：同一次載入裡問幾次都只有一趟網路。
 * 換了金鑰之後要重新問的那一趟由設定頁負責 —— 它存完會呼叫
 * `forgetAiReviewAvailability()`，不然「剛剛才設好金鑰」的那次要重新整理才會通。
 */
let capsPromise = null;

export function aiReviewAvailability() {
  if (!capsPromise) {
    capsPromise = fetch('/api/capabilities')
      .then((res) => (res.ok ? res.json() : null))
      .then((caps) => caps?.aiReview ?? null)
      // 讀不到不等於不能用 —— 回 null（「不知道」），畫面上不要說死。
      // 說死的代價是使用者以為功能壞了，而其實只是這一趟請求掉了
      .catch(() => null);
  }
  return capsPromise;
}

/** 金鑰改過之後把快取丟掉，下一次會重新問。設定頁存完金鑰時呼叫。 */
export function forgetAiReviewAvailability() {
  capsPromise = null;
}

/**
 * 送一句話去要一次 AI 修正。**不丟例外** —— 一律回一個可以直接顯示的結果。
 *
 * 為什麼連網路錯誤都不丟：呼叫端是「對答案」之後的一段附加資訊，
 * 本地批改與參考答案已經在畫面上了。丟例外的話那邊就要再寫一層 try，
 * 而漏掉的症狀是整個模式當掉 —— 代價完全不對等。
 *
 * @param {object} task 見 server/coach.js 的 parseReviewRequest：
 *   input（必要）、reference、intent_zh、setting_zh、your_role_zh、
 *   partner_role_zh、partner_line、accept
 * @returns {Promise<{ok: true, review: object, label?: string, ms?: number}
 *   | {ok: false, reason: 'no_key'|'failed'|'no_input', message: string}>}
 */
export async function requestDialogueReview(task) {
  try {
    const res = await fetch('/api/dialogue-review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(task),
    });
    const body = await res.json().catch(() => null);

    if (!res.ok) {
      return {
        ok: false,
        reason: body?.error === 'no_input' ? 'no_input' : 'failed',
        message: body?.message ?? `AI 修正失敗（HTTP ${res.status}）。`,
      };
    }
    if (!body?.ok) {
      return {
        ok: false,
        // quota 是「今天的次數用完了」—— 跟 failed 分開，因為再按一次也沒有用
        reason: ['no_key', 'quota'].includes(body?.reason) ? body.reason : 'failed',
        message: body?.message ?? 'AI 修正這次沒有回來。',
        quota: body?.quota ?? null,
      };
    }
    return body;
  } catch (err) {
    console.error('[ai-review]', err);
    return {
      ok: false,
      reason: 'failed',
      message: '連不到伺服器，AI 修正這次沒有回來（本地批改與參考答案不受影響）。',
    };
  }
}

/**
 * 判定的三級要怎麼顯示。伺服器只回 `ok` / `minor` / `major` 三個字 ——
 * 中文與顏色是畫面的事，寫在前端。
 */
/**
 * 「今天還剩幾次」那一行。剩很多的時候不寫 —— 每一句都提醒剩幾次，
 * 會把一個安全網變成一個計時器。
 *
 * @param {{remaining: number|null}|null|undefined} quota 伺服器回來的額度資訊
 */
export function quotaNote(quota) {
  const left = quota?.remaining;
  if (typeof left !== 'number') return '';   // 沒有設上限
  if (left > 20) return '';
  return left > 0
    ? `今天還可以呼叫 ${left} 次（所有模式一起算）。`
    : '今天的呼叫次數已經用完了。';
}

export const VERDICT_HEAD = {
  ok: ['🤖 AI：這樣說可以', 'ok'],
  minor: ['🤖 AI：可以更自然', 'close'],
  major: ['🤖 AI：這句要改', 'bad'],
};
