// §2.3：把 MediaRecorder 錄到的 Blob（webm/opus 或 Safari 的 mp4/aac）
// 轉成 16 kHz 單聲道 16-bit PCM WAV。
//
// 為什麼要轉：Gemini API 的 audio 文件與 Firebase AI Logic 的輸入需求頁
// 對 audio/webm 的支援說法不一致，而 webm 正好是 MediaRecorder 的預設輸出。
// audio/wav 在兩份文件裡都明確支援，所以一律轉成 WAV 再送。
// 附帶好處：Safari 吐的是 mp4/aac，但走 decodeAudioData 這條路兩邊就統一了。

const TARGET_SAMPLE_RATE = 16000;

// 無人聲判斷的門檻。這幾個值跟 server/audio.js 的必須一致 —— 兩邊要一起改。
// 前端這份是為了即時擋下、省掉一次上傳與 API 呼叫；後端那份才是真正的把關
// （前端送什麼上來都不能信）。門檻是拿真實語音校準過的，見 test/audio.test.js。
const PEAK_FLOOR = 0.02;
const FRAME_RMS_FLOOR = 0.015;
const VOICED_RATIO_FLOOR = 0.02;
const FLATNESS_FLOOR = 0.08;
const FRAME_MS = 20;
/** 峰值低於這個值就提醒使用者音量偏小（但仍然允許送出）。 */
const QUIET_PEAK = 0.08;

/**
 * 解碼任意瀏覽器錄音格式，重新取樣成 16 kHz 單聲道，編成 WAV。
 * @param {Blob} blob MediaRecorder 產生的錄音
 * @returns {Promise<{blob: Blob, durationSec: number, sampleRate: number, stats: object}>}
 */
export async function blobToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('這個瀏覽器不支援 Web Audio API，無法轉換錄音格式。');

  // 先用一般的 AudioContext 解碼取得 PCM。
  const decodeCtx = new AudioCtx();
  let decoded;
  try {
    // Safari 舊版的 decodeAudioData 不回 Promise，包一層兼容。
    decoded = await new Promise((resolve, reject) => {
      const maybePromise = decodeCtx.decodeAudioData(arrayBuffer, resolve, reject);
      if (maybePromise?.then) maybePromise.then(resolve, reject);
    });
  } finally {
    decodeCtx.close();
  }

  // 再用 OfflineAudioContext 一次做完「降到單聲道」與「重新取樣到 16 kHz」。
  // 直接抽樣（decimation）會產生 aliasing，交給瀏覽器的重取樣器比較乾淨。
  const frameCount = Math.max(
    1,
    Math.ceil(decoded.duration * TARGET_SAMPLE_RATE)
  );
  const offline = new OfflineAudioContext(1, frameCount, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();

  const samples = rendered.getChannelData(0);
  return {
    blob: encodeWav(samples, TARGET_SAMPLE_RATE),
    durationSec: rendered.duration,
    sampleRate: TARGET_SAMPLE_RATE,
    stats: analyseSamples(samples, TARGET_SAMPLE_RATE),
  };
}

/**
 * 算出這段錄音的音量特徵，用來判斷「到底有沒有人在說話」。
 *
 * 為什麼需要這個：實測把純靜音送給 Gemini，flash 系列會把提示裡的目標句
 * 當成聽到的內容並回 95～98 分（詳見 server/audio.js 開頭的紀錄）。
 * 那個問題沒辦法靠 prompt 修，只能在送出前用訊號本身判斷。
 *
 * @param {Float32Array} samples 單聲道 PCM
 * @returns {{peak: number, rms: number, voicedRatio: number, flatness: number,
 *            silent: boolean, quiet: boolean}}
 */
export function analyseSamples(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const framesPerWindow = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));

  let peak = 0;
  let sumSquares = 0;
  const windowRms = [];
  let windowSumSquares = 0;
  let windowCount = 0;

  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
    sumSquares += v * v;

    windowSumSquares += v * v;
    if (++windowCount === framesPerWindow) {
      windowRms.push(Math.sqrt(windowSumSquares / windowCount));
      windowSumSquares = 0;
      windowCount = 0;
    }
  }
  if (windowCount > 0) windowRms.push(Math.sqrt(windowSumSquares / windowCount));

  const voiced = windowRms.filter((r) => r > FRAME_RMS_FLOOR).length;
  const voicedRatio = windowRms.length ? voiced / windowRms.length : 0;

  // 變異係數：音量起伏的程度。真人說話因為有音節，實測約 1.2；
  // 穩定的電流聲／冷氣聲約 0.008，差兩個數量級。
  let flatness = Infinity;
  if (windowRms.length >= 2) {
    const mean = windowRms.reduce((a, b) => a + b, 0) / windowRms.length;
    if (mean <= 0) {
      flatness = 0;
    } else {
      const variance =
        windowRms.reduce((acc, r) => acc + (r - mean) * (r - mean), 0) / windowRms.length;
      flatness = Math.sqrt(variance) / mean;
    }
  }

  return {
    peak,
    rms: samples.length ? Math.sqrt(sumSquares / samples.length) : 0,
    voicedRatio,
    flatness,
    silent:
      peak < PEAK_FLOOR || voicedRatio < VOICED_RATIO_FLOOR || flatness < FLATNESS_FLOOR,
    quiet: peak < QUIET_PEAK,
  };
}

/**
 * Float32 samples → 16-bit PCM WAV Blob（單聲道）。
 * 44 bytes 的標準 RIFF header，不需要任何外部套件。
 */
export function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // 之後所有 bytes
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk 長度
  view.setUint16(20, 1, true); // audio format：1 = PCM
  view.setUint16(22, 1, true); // 聲道數：單聲道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    // clamp 後轉成 signed 16-bit
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
