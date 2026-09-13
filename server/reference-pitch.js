// 「範例句」的語調曲線：合成一次、存起來、之後直接用。
//
// ─── 為什麼是懶產生，不是建置時全部先算 ──────────────────────────────────
//
// 句庫有 2,041 句，而一個人實際會練到的大概一兩百句 —— 全部先算等於先付
// 二十倍的錢買一份大部分用不到的資料，而且每次句庫長出新句子就要再跑一次。
// 懶產生只為真的練到的句子付錢，之後的「AI 對話」模式（句子是當場生出來的）
// 也用得上同一條路。
//
// ─── 抽曲線的程式跟前端是同一份 ──────────────────────────────────────────
//
// `public/lib/pitch.js` 是純函式（沒有 DOM、沒有 Web Audio），所以伺服器直接
// import。**這一點是這個功能的前提**：兩套程式算出來的兩條曲線會有系統性差異
// （窗長、門檻、平滑各差一點），而那種差異在圖上看起來就像「我唸得不像」。
// `public/lib/merge.js` 已經是同樣的先例。

import { compactContour, pitchContour } from '../public/lib/pitch.js';
import { decodeWavPcm16 } from './audio.js';
import { synthesize, ttsVoice } from './tts.js';

/** 一句最長多少字元才合成。防呆用 —— 句庫裡最長的句子也只有一百多個字元。 */
const MAX_TEXT = 400;

/**
 * 拿一句的參考曲線。有快取就用快取（**不花錢、也不扣額度**）。
 *
 * @param {object} args
 * @param {*} args.id 句子 id（快取的鍵）
 * @param {string} args.text 要合成的英文
 * @param {object} args.store `createStore()` 的結果
 * @param {() => Promise<{allowed: boolean}>} [args.spend]
 *   快取沒中、真的要呼叫 Azure 之前扣額度。回 `allowed: false` 就不做。
 *   **在合成之前扣** —— 扣完再呼叫的話，額度用完的那一次還是花了錢
 * @param {string} [args.voice]
 * @param {Function} [args.synthesizerFactory] 測試用（注入假的合成器）
 * @returns {Promise<{ok: true, doc: object, cached: boolean, quota?: object}
 *   | {ok: false, reason: string, quota?: object}>}
 */
export async function getReferencePitch({
  id, text, store, spend, voice = ttsVoice(), synthesizerFactory,
}) {
  const sentence = String(text ?? '').trim();
  if (!sentence || sentence.length > MAX_TEXT) return { ok: false, reason: 'bad_text' };

  const cached = await store.readPitch(voice, id);
  if (isUsable(cached)) return { ok: true, doc: cached, cached: true };

  const verdict = spend ? await spend() : { allowed: true };
  if (!verdict.allowed) return { ok: false, reason: 'quota', quota: verdict };

  const { audio, words } = await synthesize(sentence, { voice, synthesizerFactory });
  const doc = buildDoc({ id, text: sentence, voice, audio, words });
  if (!doc) return { ok: false, reason: 'no_pitch', quota: verdict };

  // 存不進去不算失敗 —— 曲線已經算出來了，這一次照樣看得到圖，
  // 只是下一次要再合成一遍（會再扣一次額度，所以錯誤要留在 console 裡）
  await store.writePitch(voice, id, doc).catch((err) => {
    console.error('[reference-pitch] 寫入快取失敗：', err);
  });
  return { ok: true, doc, cached: false, quota: verdict };
}

/**
 * 音訊 → 存得下的文件。**純函式，測得到**（吃 Buffer，不碰網路也不碰檔案）。
 *
 * 抽不出音高就回 null：那代表合成出來的東西有問題，
 * 存一份空的曲線只會讓每次都拿到一張畫不出來的圖，而且不會再重試。
 */
export function buildDoc({ id, text, voice, audio, words = [], now = Date.now() }) {
  const decoded = decodeWavPcm16(audio);
  if (!decoded.ok) {
    console.error('[reference-pitch] 解不開合成出來的音訊：', decoded.reason);
    return null;
  }

  const contour = pitchContour(decoded.samples, decoded.sampleRate);
  if (contour.medianHz === null) return null;

  return {
    id,
    text,
    voice,
    ...compactContour(contour),
    // 逐字時間是對齊兩條曲線的依據（見 lib/pitch-chart.js 的 alignReference）
    words: words.map((w) => ({
      word: w.word,
      start: round3(w.start),
      duration: round3(w.duration),
    })),
    durationSec: round3(decoded.samples.length / decoded.sampleRate),
    at: new Date(now).toISOString(),
  };
}

/**
 * 存下來的東西還能不能用。
 *
 * 會不能用的情況：改過曲線的格式、手改過檔案、或是上一版存進了空的曲線。
 * 認不得就當成沒有快取（重新產生一份）—— 拿一份壞掉的資料去畫圖，
 * 症狀是圖歪掉而不是報錯，那種東西沒有人查得出來。
 */
export function isUsable(doc) {
  return Boolean(
    doc && Array.isArray(doc.points) && doc.points.length > 0 &&
    typeof doc.hopSec === 'number' && doc.points.some((p) => typeof p === 'number')
  );
}

function round3(n) {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}
