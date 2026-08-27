// §2.3：把 MediaRecorder 錄到的 Blob（webm/opus 或 Safari 的 mp4/aac）
// 轉成 16 kHz 單聲道 16-bit PCM WAV。
//
// 為什麼要轉：Gemini API 的 audio 文件與 Firebase AI Logic 的輸入需求頁
// 對 audio/webm 的支援說法不一致，而 webm 正好是 MediaRecorder 的預設輸出。
// audio/wav 在兩份文件裡都明確支援，所以一律轉成 WAV 再送。
// 附帶好處：Safari 吐的是 mp4/aac，但走 decodeAudioData 這條路兩邊就統一了。

const TARGET_SAMPLE_RATE = 16000;

/**
 * 解碼任意瀏覽器錄音格式，重新取樣成 16 kHz 單聲道，編成 WAV。
 * @param {Blob} blob MediaRecorder 產生的錄音
 * @returns {Promise<{blob: Blob, durationSec: number, sampleRate: number}>}
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
