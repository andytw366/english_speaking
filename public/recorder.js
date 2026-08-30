// 錄音：getUserMedia → MediaRecorder → 轉成 16 kHz 單聲道 WAV。
//
// 這個模組**不碰任何 DOM**，畫面更新一律透過 callback 交給 app.js。
// 抽出來的理由是這裡有一整組互相牽連的資源（audio track、MediaRecorder、
// 兩個 timer、AnalyserNode、Blob URL），漏掉任何一個的症狀都是
// 「麥克風燈一直亮著」或「錄第二次時波形不動」—— 很難從畫面反推。

import { blobToWav } from './wav-encoder.js';

/** 單次錄音的上限。超過就自動停止，不要讓使用者錄出一個送不出去的檔案。 */
export const MAX_RECORDING_MS = 60_000;

// 踩雷清單 #5：不要寫死 webm，Safari 的 MediaRecorder 不支援。
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
  return ''; // 交給瀏覽器自己決定
}

/**
 * 麥克風打不開的原因分很多種，而每一種使用者要做的事情完全不同 ——
 * 只講「無法開啟麥克風」等於要對方自己猜。
 */
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
 * 建立錄音器。
 *
 * @param {object} handlers
 * @param {(waveform: object) => void} [handlers.waveform] 波形視覺化（createWaveform 的結果）
 * @param {(text: string, kind?: string) => void} handlers.onStatus 狀態訊息
 * @param {(isRecording: boolean) => void} handlers.onRecordingChange 錄音中／不錄音的畫面切換
 * @param {(elapsedSec: number) => void} handlers.onTick 每 200ms 一次的計時
 * @param {(result: object) => void} handlers.onResult 錄完並轉檔後的結果
 */
export function createRecorder({ waveform, onStatus, onRecordingChange, onTick, onResult }) {
  let recorder = null;
  let stream = null;
  let chunks = [];
  let timerId = null;
  let autoStopId = null;
  let startedAt = 0;

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  function clearTimers() {
    clearInterval(timerId);
    clearTimeout(autoStopId);
    timerId = null;
    autoStopId = null;
  }

  async function start() {
    reset();
    onStatus('正在要求麥克風權限…');

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error('[getUserMedia]', err);
      onStatus(describeMicError(err), 'error');
      return;
    }

    const mimeType = pickMimeType();
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch (err) {
      console.error('[MediaRecorder]', err);
      stopStream();
      onStatus(
        '這個瀏覽器無法用目前的音訊格式錄音，建議改用最新版的 Chrome、Edge 或 Safari。',
        'error'
      );
      return;
    }

    chunks = [];
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });
    recorder.addEventListener('error', (e) => {
      console.error('[MediaRecorder error]', e);
      onStatus('錄音過程中發生錯誤，請重新錄一次。', 'error');
      stopStream();
      onRecordingChange(false);
    });
    recorder.addEventListener('stop', handleStopped);

    recorder.start();
    startedAt = Date.now();
    onRecordingChange(true);
    // 即時波形。畫不出來也不影響錄音，所以失敗就算了。
    waveform?.start(stream);
    onStatus(`錄音中，唸完後按「停止錄音」。（最長 ${MAX_RECORDING_MS / 1000} 秒）`);

    timerId = setInterval(() => onTick(Math.floor((Date.now() - startedAt) / 1000)), 200);
    autoStopId = setTimeout(() => {
      if (recorder?.state === 'recording') {
        onStatus('已達最長錄音時間，自動停止。');
        recorder.stop();
      }
    }, MAX_RECORDING_MS);
  }

  function stop() {
    if (recorder?.state === 'recording') recorder.stop();
  }

  async function handleStopped() {
    clearTimers();
    onRecordingChange(false);
    // 先停波形再關 stream —— 反過來的話 AnalyserNode 會讀到已經結束的 track
    waveform?.stop();
    stopStream();

    const recordedType = recorder?.mimeType || chunks[0]?.type || 'audio/webm';
    const raw = new Blob(chunks, { type: recordedType });

    if (raw.size === 0) {
      onStatus('沒有錄到任何聲音，請確認麥克風有在運作後再試一次。', 'error');
      return;
    }

    onStatus('正在把錄音轉成 WAV…', 'busy');

    try {
      // §2.3：不要把 webm 直接送給 API，一律轉成 16 kHz 單聲道 WAV。
      const wav = await blobToWav(raw);
      console.log(
        `[WAV] 原始錄音 ${recordedType} ${(raw.size / 1024).toFixed(1)} KB → ` +
          `WAV ${(wav.blob.size / 1024).toFixed(1)} KB / ${wav.durationSec.toFixed(2)} 秒 / ` +
          `${wav.sampleRate} Hz 單聲道`
      );
      console.log(
        `[音量] peak=${wav.stats.peak.toFixed(4)} rms=${wav.stats.rms.toFixed(4)} ` +
          `有聲比例=${(wav.stats.voicedRatio * 100).toFixed(1)}% ` +
          `起伏=${wav.stats.flatness.toFixed(3)}`
      );
      onResult({ raw, recordedType, wav, error: null });
    } catch (err) {
      console.error('[WAV 轉換失敗]', err);
      // 轉換失敗時仍把原始錄音交出去，至少使用者聽得到有沒有錄進東西
      onResult({ raw, recordedType, wav: null, error: err });
    }
  }

  /** 丟掉這次錄音的所有狀態與資源。換句子、重錄、頁面離開都會走這裡。 */
  function reset() {
    stopStream();
    waveform?.reset();
    clearTimers();
    chunks = [];
    recorder = null;
    onRecordingChange(false);
  }

  return {
    start,
    stop,
    reset,
    stopStream,
    isRecording: () => recorder?.state === 'recording',
    /** 錄音器是否處於「這一輪還沒結束」的狀態（reset 之後為 false）。 */
    isActive: () => recorder !== null,
  };
}
