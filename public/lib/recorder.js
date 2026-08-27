import { blobToWav } from './wav-encoder.js';

// 錄音流程包一層：權限、格式挑選、轉 WAV、錯誤訊息全部集中在這裡，
// 讓各個模式只要處理「拿到 WAV 之後要做什麼」。

export const MAX_RECORDING_MS = 60_000;

export function isSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
}

export function unsupportedReason() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return (
      '這個瀏覽器不支援麥克風錄音（getUserMedia）。\n' +
      '常見原因是網址不是 localhost —— 麥克風需要 secure context，' +
      '用區網 IP（例如 192.168.x.x）開啟會失效。請改用 http://localhost:3000。'
    );
  }
  if (typeof MediaRecorder === 'undefined') {
    return '這個瀏覽器不支援 MediaRecorder，無法錄音。建議改用最新版的 Chrome、Edge 或 Safari。';
  }
  return '';
}

// 不要寫死 webm，Safari 的 MediaRecorder 不支援。
function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export function describeMicError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return (
        '麥克風權限被拒絕了。\n' +
        '請點網址列左側的鎖頭圖示 →「網站設定」→ 把「麥克風」改成「允許」，' +
        '然後重新整理這個頁面。'
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return (
        '找不到可用的麥克風。\n' +
        '請確認麥克風已接上，並在系統的「聲音」設定裡確認它有被偵測到，再重新整理頁面。'
      );
    case 'NotReadableError':
    case 'TrackStartError':
      return '麥克風被其他程式占用了（例如視訊會議軟體）。\n請關掉那個程式後再試一次。';
    case 'OverconstrainedError':
      return '找不到符合條件的麥克風裝置，請改用系統預設的麥克風。';
    case 'SecurityError':
      return '瀏覽器基於安全性擋下了麥克風，請確認你是從 localhost 開啟這個頁面。';
    default:
      return `無法開啟麥克風（${err?.name || '未知錯誤'}）：${err?.message || ''}`;
  }
}

/**
 * 一次錄音的生命週期。
 *
 * const rec = new Recorder({ onTick, onAutoStop });
 * await rec.start();          // 可能 throw（權限、裝置）
 * const result = await rec.stop();   // { wav, raw, durationSec, sampleRate, recordedType }
 */
export class Recorder {
  constructor({ onTick, onAutoStop } = {}) {
    this.onTick = onTick;
    this.onAutoStop = onAutoStop;
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.timerId = null;
    this.autoStopId = null;
    this.startedAt = 0;
  }

  get isRecording() {
    return this.recorder?.state === 'recording';
  }

  async start() {
    this.cleanup();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const mimeType = pickMimeType();
    this.recorder = mimeType
      ? new MediaRecorder(this.stream, { mimeType })
      : new MediaRecorder(this.stream);

    this.chunks = [];
    this.recorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    });

    this.recorder.start();
    this.startedAt = Date.now();

    this.timerId = setInterval(() => {
      this.onTick?.(Math.floor((Date.now() - this.startedAt) / 1000));
    }, 200);

    this.autoStopId = setTimeout(() => {
      if (this.isRecording) this.onAutoStop?.();
    }, MAX_RECORDING_MS);
  }

  /** 停止並回傳轉好的 WAV。錄不到聲音或轉換失敗會 throw。 */
  stop() {
    return new Promise((resolve, reject) => {
      if (!this.recorder) return reject(new Error('目前沒有在錄音。'));

      this.recorder.addEventListener(
        'stop',
        async () => {
          clearInterval(this.timerId);
          clearTimeout(this.autoStopId);
          this.releaseStream();

          const recordedType = this.recorder?.mimeType || this.chunks[0]?.type || 'audio/webm';
          const raw = new Blob(this.chunks, { type: recordedType });

          if (raw.size === 0) {
            return reject(new Error('沒有錄到任何聲音，請確認麥克風有在運作後再試一次。'));
          }

          try {
            // 一律轉成 16 kHz 單聲道 WAV 再送出去。
            const converted = await blobToWav(raw);
            resolve({
              wav: converted.blob,
              raw,
              durationSec: converted.durationSec,
              sampleRate: converted.sampleRate,
              recordedType,
            });
          } catch (err) {
            // 讓呼叫端還能播放原始錄音，至少判斷得出有沒有錄到聲音
            err.raw = raw;
            err.recordedType = recordedType;
            reject(err);
          }
        },
        { once: true }
      );

      this.recorder.stop();
    });
  }

  releaseStream() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  cleanup() {
    clearInterval(this.timerId);
    clearTimeout(this.autoStopId);
    this.releaseStream();
    this.chunks = [];
    this.recorder = null;
  }
}
