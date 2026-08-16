// 錄音能量分析 —— 在呼叫 Gemini 之前先擋掉沒有人聲的錄音。
//
// 為什麼要在後端做，而不是只寫在 prompt 裡：
// 實測（2026-08）把一段「全部樣本都是 0」的純靜音 WAV 送給各 model，
// 明確要求「沒聽到人聲就給 0 分、transcript 留空」，結果：
//   gemini-3.7-flash   → speech_detected=true, score=95, transcript 照抄目標句
//   gemini-3.6-flash   → speech_detected=true, score=98, transcript 照抄目標句
//   gemini-3.5-flash   → speech_detected=true, score=95, transcript 照抄目標句
//   gemini-3.5-flash-lite / gemini-3.1-flash-lite → 正確給 0 分
// 也就是說 flash 系列會直接把提示裡的目標句當成「聽到的內容」。
// prompt 擋不住，模型自評的 speech_detected 也擋不住，所以只能在送進 API 前用訊號本身判斷。
//
// 前端 public/wav-encoder.js 有一份等價的檢查，那份是為了即時提示與省一次上傳；
// 這裡才是真正的把關（前端送什麼上來都不能信）。兩邊的門檻值要一起改。

/** 峰值低於這個振幅（約 -34 dBFS）就當作完全沒有收到聲音。 */
export const PEAK_FLOOR = 0.02;
/** 單一 20 ms 音框要超過這個 RMS 才算「有聲」。 */
export const FRAME_RMS_FLOOR = 0.015;
/** 有聲音框佔比低於這個值，就當作整段沒有人在說話。 */
export const VOICED_RATIO_FLOOR = 0.02;
/**
 * 音框能量的變異係數（標準差 / 平均）低於這個值 = 音量從頭到尾幾乎不變，
 * 那是穩定的電流聲／冷氣聲／測試音，不是人在說話 —— 語音一定有音節造成的起伏。
 * 這個門檻刻意設得很寬鬆（真實語音實測遠高於 0.3），寧可漏擋也不要誤擋真人錄音。
 */
export const FLATNESS_FLOOR = 0.08;

const FRAME_MS = 20;

/**
 * 解析 16-bit PCM 的 WAV，算出峰值、RMS 與有聲音框佔比。
 *
 * 前端一律送 16 kHz 單聲道 16-bit PCM（public/wav-encoder.js），
 * 但這裡仍然自己讀 header，遇到不認得的格式就回 analysed:false 放行，
 * 讓後面的流程照常處理 —— 寧可漏擋，也不要把正常的錄音誤判成靜音。
 *
 * @param {Buffer} buf
 * @returns {{analysed: boolean, reason?: string, peak?: number, rms?: number,
 *            voicedRatio?: number, durationSec?: number}}
 */
export function analyseWavPcm16(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) {
    return { analysed: false, reason: 'too_short' };
  }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { analysed: false, reason: 'not_wav' };
  }

  // RIFF 的 chunk 不保證照順序、也不保證 fmt 一定是 16 bytes，所以老實走一遍。
  let fmt = null;
  let dataStart = -1;
  let dataLength = 0;
  let offset = 12;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataStart = body;
      // 有些編碼器會把 size 寫成 0 或超過實際長度，取實際可用的部分。
      dataLength = Math.min(size, Math.max(0, buf.length - body));
    }

    // chunk 大小是奇數時要補一個 padding byte
    offset = body + size + (size % 2);
    if (size === 0) break; // 壞掉的 header，別無限迴圈
  }

  if (!fmt || dataStart < 0) return { analysed: false, reason: 'no_chunks' };
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    return { analysed: false, reason: 'not_pcm16' };
  }

  const channels = Math.max(1, fmt.channels);
  const totalSamples = Math.floor(dataLength / 2);
  const frames = Math.floor(totalSamples / channels);
  if (frames === 0) return { analysed: true, peak: 0, rms: 0, voicedRatio: 0, durationSec: 0 };

  const framesPerWindow = Math.max(1, Math.round((fmt.sampleRate * FRAME_MS) / 1000));

  let peak = 0;
  let sumSquares = 0;
  let voicedWindows = 0;
  let totalWindows = 0;
  let windowSumSquares = 0;
  let windowCount = 0;
  const windowRms = [];

  for (let f = 0; f < frames; f++) {
    // 多聲道時取平均，等同降成單聲道
    let mixed = 0;
    for (let c = 0; c < channels; c++) {
      mixed += buf.readInt16LE(dataStart + (f * channels + c) * 2) / 32768;
    }
    mixed /= channels;

    const abs = Math.abs(mixed);
    if (abs > peak) peak = abs;
    sumSquares += mixed * mixed;

    windowSumSquares += mixed * mixed;
    if (++windowCount === framesPerWindow) {
      const r = Math.sqrt(windowSumSquares / windowCount);
      windowRms.push(r);
      totalWindows++;
      if (r > FRAME_RMS_FLOOR) voicedWindows++;
      windowSumSquares = 0;
      windowCount = 0;
    }
  }
  // 收尾不滿一個 window 的部分
  if (windowCount > 0) {
    const r = Math.sqrt(windowSumSquares / windowCount);
    windowRms.push(r);
    totalWindows++;
    if (r > FRAME_RMS_FLOOR) voicedWindows++;
  }

  return {
    analysed: true,
    peak,
    rms: Math.sqrt(sumSquares / frames),
    voicedRatio: totalWindows ? voicedWindows / totalWindows : 0,
    flatness: coefficientOfVariation(windowRms),
    durationSec: frames / fmt.sampleRate,
  };
}

/** 變異係數：標準差 / 平均。值越小代表音量越平穩。 */
function coefficientOfVariation(values) {
  if (values.length < 2) return Infinity; // 樣本太少就別下判斷
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return 0;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/**
 * 這段錄音是不是「幾乎沒有聲音」。
 * 只有在確定分析成功時才會回 true —— 分析不了就放行。
 */
export function isSilentRecording(stats) {
  if (!stats?.analysed) return false;
  if (stats.peak < PEAK_FLOOR) return true;
  if (stats.voicedRatio < VOICED_RATIO_FLOOR) return true;
  // 有音量但從頭到尾一動也不動 → 穩定噪音，不是語音
  if (stats.flatness < FLATNESS_FLOOR) return true;
  return false;
}
