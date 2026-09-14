import * as sdk from 'microsoft-cognitiveservices-speech-sdk';

import { AzureError, hasAzureConfig } from './azure-pronunciation.js';

// Azure 語音合成。**只為了一件事存在：算出「範例句」的語調曲線。**
//
// 為什麼不是拿瀏覽器的 speechSynthesis：那個 API 沒有任何辦法把唸出來的聲音
// 接回程式裡（沒有 MediaStream、也進不了 Web Audio），所以拿不到音訊就抽不出曲線。
// 要有參考曲線，只能另外合成一份。
//
// 為什麼是 Azure：發音評估已經在用同一組金鑰與同一個 SDK，不必多一組設定、
// 也不必多一個廠商。輸出格式直接指定 16 kHz 單聲道 16-bit PCM ——
// 跟前端的錄音管線（public/lib/wav-encoder.js）同格式，兩條曲線的來源一致。
//
// **這裡不存檔、不管快取**，那是 reference-pitch.js 的事。

const TIMEOUT_MS = 20_000;

/**
 * 預設音色。可以用 .env 的 `AZURE_TTS_VOICE` 換掉。
 *
 * 換音色會讓曲線整個變一份 —— 所以音色是快取鍵的一部分（見 reference-pitch.js），
 * 換了之後舊的快取不會被誤用，只是要重新產生。
 */
export const DEFAULT_VOICE = 'en-US-JennyNeural';

export function ttsVoice() {
  return process.env.AZURE_TTS_VOICE?.trim() || DEFAULT_VOICE;
}

/**
 * 合成一句英文，回音訊與逐字時間。
 *
 * 逐字時間來自 SDK 的 `wordBoundary` 事件 —— **這是對齊兩條曲線的依據**，
 * 沒有它就只能把整句硬拉成同樣長度，唸得比較慢的人整條線都會歪掉。
 *
 * @param {string} text
 * @param {{voice?: string, synthesizerFactory?: Function}} [options]
 *   synthesizerFactory 是給測試注入用的 —— 真的呼叫 Azure 要金鑰也要花錢
 * @returns {Promise<{audio: Buffer, words: Array<{word: string, start: number, duration: number}>}>}
 */
export async function synthesize(text, { voice = ttsVoice(), synthesizerFactory } = {}) {
  const make = synthesizerFactory ?? defaultSynthesizer;
  const synthesizer = make(voice);
  const words = [];

  synthesizer.wordBoundary = (_sender, event) => {
    // Azure 的時間單位是 100 奈秒。`audioOffset` 是從音訊開頭算起，
    // 跟我們自己抽的曲線同一個時間軸
    const start = ticksToSec(event?.audioOffset);
    if (start === null) return;
    words.push({
      word: String(event?.text ?? ''),
      start,
      duration: ticksToSec(event?.duration) ?? 0,
    });
  };

  try {
    const audio = await speak(synthesizer, text);
    // 標點也會發 wordBoundary（Azure 的 boundaryType 有 Word / Punctuation / Sentence），
    // 而標點在圖上標出來只是雜訊 —— 沒有字的那些直接丟掉
    return { audio, words: words.filter((w) => /[a-z]/i.test(w.word)) };
  } finally {
    synthesizer.close();
  }
}

function defaultSynthesizer(voice) {
  if (!hasAzureConfig()) {
    throw new AzureError(
      'missing_azure_config',
      500,
      '伺服器沒有設定 Azure Speech 金鑰，所以產生不了範例的語調曲線。'
    );
  }
  const speechConfig = sdk.SpeechConfig.fromSubscription(
    process.env.AZURE_SPEECH_KEY.trim(),
    process.env.AZURE_SPEECH_REGION.trim()
  );
  speechConfig.speechSynthesisVoiceName = voice;
  // 跟錄音管線同格式（16 kHz / 16-bit / 單聲道 PCM），一個 byte 都不用轉
  speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm;
  // 不給 AudioConfig = 不要播出來（伺服器上沒有喇叭，給 null 才不會去開音訊裝置）
  return new sdk.SpeechSynthesizer(speechConfig, null);
}

function speak(synthesizer, text) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AzureError('timeout', 504,
        `Azure 語音合成超過 ${TIMEOUT_MS / 1000} 秒沒有回應。`));
    }, TIMEOUT_MS);

    synthesizer.speakTextAsync(
      text,
      (result) => {
        clearTimeout(timer);
        if (result?.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          resolve(Buffer.from(result.audioData));
          return;
        }
        const details = result?.errorDetails ?? `reason=${result?.reason}`;
        console.error('[tts] 合成失敗：', details);
        reject(new AzureError('synthesis_failed', 502,
          'Azure 語音合成沒有成功，詳細原因請看伺服器 console。'));
      },
      (err) => {
        clearTimeout(timer);
        console.error('[tts] speakTextAsync 失敗：', err);
        reject(new AzureError('sdk_error', 500,
          '呼叫 Azure 語音合成時發生錯誤，詳細原因請看伺服器 console。', err));
      }
    );
  });
}

/** Azure 的時間單位是 100 奈秒。讀不到回 null。 */
function ticksToSec(ticks) {
  const n = Number(ticks);
  return Number.isFinite(n) && n >= 0 ? n / 10_000_000 : null;
}
