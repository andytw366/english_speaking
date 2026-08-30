// 後端 API 的呼叫。
//
// 集中在這裡的理由：錯誤訊息要用同一套語氣，而且「連不上伺服器」跟
// 「伺服器回了錯誤」在使用者眼中是兩件事，兩邊的提示不能混為一談。

/** 練習句。拿不到就沒東西可練，所以直接丟出去讓呼叫端顯示致命錯誤。 */
export async function fetchSentences() {
  const res = await fetch('/api/sentences');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const sentences = await res.json();
  if (!Array.isArray(sentences) || sentences.length === 0) {
    throw new Error('sentences.json 是空的');
  }
  return sentences;
}

/** 可選的 model 清單。前端不寫死 model 名稱，白名單由後端提供也由後端驗。 */
export async function fetchModels() {
  const res = await fetch('/api/models');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  const models = Array.isArray(payload.models) ? payload.models : [];
  if (models.length === 0) throw new Error('後端沒有回傳任何可用的 model');
  return { models, default: payload.default };
}

/**
 * 送出錄音，取得發音講評。
 *
 * @returns {{ok: true, data: object} | {ok: false, message: string}}
 *          失敗時一律回「可以直接顯示給使用者的中文訊息」，不丟例外 ——
 *          呼叫端要做的事情（重新啟用送出鍵、顯示訊息）在兩種情況下是一樣的。
 */
export async function submitFeedback({ wavBlob, sentence, model }) {
  const form = new FormData();
  form.append('audio', wavBlob, 'recording.wav');
  form.append('sentence', sentence);
  if (model) form.append('model', model);

  let res;
  try {
    res = await fetch('/api/pronunciation-feedback', { method: 'POST', body: form });
  } catch (err) {
    console.error('[submit]', err);
    return {
      ok: false,
      message:
        '連不上伺服器。請確認後端還在執行（終端機裡的 npm start 沒有中斷），再試一次。',
    };
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    // 後端會針對每種失敗給中文說明；沒有的話才退回講 HTTP 狀態碼
    return {
      ok: false,
      message: payload?.message ?? `伺服器回了 HTTP ${res.status}，請稍後再試一次。`,
    };
  }
  return { ok: true, data: payload };
}
