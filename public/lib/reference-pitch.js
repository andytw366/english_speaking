// 「範例句」的語調曲線：去伺服器要一份，記在記憶體裡。
//
// ─── 什麼時候要 ──────────────────────────────────────────────────────────
//
// 由呼叫端決定，而規則是：**使用者已經決定要練這一句了才要**
// （按「開始錄音」或「播放正確發音」），不是換到這一句就要。
//
// 為什麼：第一次要一句會讓伺服器呼叫一次 Azure 合成（花錢）。而「換一句」
// 是這個模式裡按得最兇的按鈕 —— 照那個時機要的話，會為一堆根本沒練的句子付錢。
//
// 反過來說也不能等到送出錄音才要：那時候使用者已經在等分數了，多一趟來回很明顯，
// 而且**範例曲線在錄之前看到其實更有用**（先知道要唸成什麼形狀，再照著唸）。
// 按下錄音鍵之後有三秒可以用，剛好把延遲藏起來。

import { expandContour } from './pitch.js';
import { api } from './session.js';

/**
 * 已經要過的句子。`id → { contour, words } | null`。
 *
 * `null` 代表**要過了但沒有**（沒設金鑰、額度用完、合成失敗）——
 * 記下來才不會每按一次錄音就再問一次伺服器。這一輪不會有了，
 * 重新整理之後會再試一次（那時候使用者可能已經去把金鑰設好了）。
 */
const cache = new Map();

/** 同一句同時被要兩次（按了播放又馬上按錄音）時，共用同一個請求。 */
const inflight = new Map();

/**
 * 這一句的參考曲線。**任何失敗都回 null，不丟例外** ——
 * 它是加分的東西，不該讓呼叫端多寫一段錯誤處理。
 *
 * @param {number|string} id 句子 id
 * @returns {Promise<{contour: object, words: Array<object>, voice: string}|null>}
 */
export async function referencePitch(id) {
  if (id === undefined || id === null) return null;
  if (cache.has(id)) return cache.get(id);
  if (inflight.has(id)) return inflight.get(id);

  const request = fetchReference(id)
    .catch((err) => {
      // 連不上、500、JSON 壞掉 —— 都只是「這次沒有範例曲線」
      console.warn('[reference-pitch]', err?.message ?? err);
      return null;
    })
    .then((value) => {
      cache.set(id, value);
      inflight.delete(id);
      return value;
    });

  inflight.set(id, request);
  return request;
}

async function fetchReference(id) {
  const payload = await api(`/api/reference-pitch/${encodeURIComponent(id)}`);
  if (!payload?.ok || !payload.pitch) {
    if (payload?.reason) console.info('[reference-pitch] 沒有範例曲線：', payload.reason);
    return null;
  }
  return {
    contour: expandContour(payload.pitch),
    words: Array.isArray(payload.pitch.words) ? payload.pitch.words : [],
    voice: payload.pitch.voice ?? '',
    // 伺服器有沒有把那段音訊也留下來。有的話「播放正確發音」就放它 ——
    // 聽到的跟圖上看到的才是同一個人（見 demoSource()）
    hasAudio: payload.pitch.hasAudio === true,
  };
}

/** 範例音訊的網址。伺服器只讀快取，沒有就回 404（前端退回瀏覽器的 TTS）。 */
export function referenceAudioUrl(id) {
  return `/api/reference-audio/${encodeURIComponent(id)}`;
}

/**
 * 「播放正確發音」該放哪一個聲音。**純函式，測得到。**
 *
 * 有存下來的範例音訊就放它，不然退回瀏覽器的 speechSynthesis。
 *
 * 為什麼要一個函式而不是一個 if：這是**一致性**的問題，錯了不會有錯誤訊息 ——
 * 圖上畫的是 Azure 的語調、耳朵聽到的是瀏覽器內建的聲音，兩個人的語調本來就不同，
 * 使用者會以為圖畫錯了。條件寫散在畫面裡的話，遲早有一條路忘了判斷。
 *
 * @param {{hasAudio?: boolean, id?: *}|null} reference `referencePitch()` 的結果
 * @param {*} id 現在這一句
 * @returns {{kind: 'audio', url: string}|{kind: 'tts'}}
 */
export function demoSource(reference, id) {
  // **要確認是同一句**：換過句子之後放上一句的音訊，那是最糟的一種 bug
  // （聽起來一切正常，只是唸的不是畫面上那句話）
  if (reference?.hasAudio && (reference.id === undefined || reference.id === id)) {
    return { kind: 'audio', url: referenceAudioUrl(id) };
  }
  return { kind: 'tts' };
}

/** 測試用：把記憶體裡的快取清掉。 */
export function clearReferenceCache() {
  cache.clear();
  inflight.clear();
}
