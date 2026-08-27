import { h, clear } from '../lib/dom.js';
import { filterBySettings } from '../lib/settings.js';
import { speak, isSupported as ttsSupported } from '../lib/tts.js';
import { Recorder, isSupported as recSupported, unsupportedReason, describeMicError, MAX_RECORDING_MS } from '../lib/recorder.js';
import { addAttempt } from '../lib/storage.js';
import { renderAssessment } from './assessment-view.js';

export const meta = { id: 'shadowing', label: '跟讀', icon: '🗣️' };

const CATEGORY_LABEL = { daily: '日常對話', interview: '面試', travel: '旅遊' };
const DIFFICULTY_LABEL = { easy: '簡單', medium: '中等', hard: '困難' };

let sentences = [];
let current = null;
let recorder = null;
let wavBlob = null;
let playbackUrl = null;
let lastResult = null;
let root = null;

export async function mount(container) {
  root = container;
  const res = await fetch('/api/content/sentences');
  if (!res.ok) throw new Error(`讀取練習句失敗（HTTP ${res.status}）`);
  const raw = await res.json();
  sentences = filterBySettings(raw);
  if (sentences.length === 0) sentences = raw;
  nextSentence();
  return cleanup;
}

function cleanup() {
  recorder?.cleanup();
  recorder = null;
  revokePlayback();
  root = null;
}

function revokePlayback() {
  if (playbackUrl) {
    URL.revokeObjectURL(playbackUrl);
    playbackUrl = null;
  }
}

function nextSentence() {
  let next = current;
  while (sentences.length > 1 && next?.id === current?.id) {
    next = sentences[Math.floor(Math.random() * sentences.length)];
  }
  current = next ?? sentences[0];
  resetAttempt();
}

function resetAttempt() {
  recorder?.cleanup();
  recorder = null;
  wavBlob = null;
  lastResult = null;
  revokePlayback();
  render();
}

function render() {
  if (!root || !current) return;
  clear(root);

  const unsupported = !recSupported() ? unsupportedReason() : '';

  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'card__meta' },
        h('span', { class: 'chip' }, CATEGORY_LABEL[current.category] ?? current.category),
        h('span', { class: 'chip chip--muted' }, DIFFICULTY_LABEL[current.difficulty] ?? current.difficulty),
      ),
      h('p', { class: 'sentence', id: 'sentence' }, current.text),
      h('div', { class: 'row' },
        ttsSupported() && h('button', { class: 'btn btn--ghost', id: 'btn-speak', onclick: playDemo }, '🔊 播放正確發音'),
        h('button', { class: 'btn btn--ghost', onclick: nextSentence }, '🔀 換一句'),
      ),
    ),
  );

  if (unsupported) {
    root.append(h('div', { class: 'banner banner--error' }, unsupported));
    return;
  }

  const recCard = h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '錄下你的發音'),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn--primary', id: 'btn-record', onclick: toggleRecord },
        h('span', { class: 'dot' }), h('span', { id: 'btn-record-label' }, '開始錄音')),
      h('span', { class: 'timer', id: 'timer', hidden: true }, '00:00'),
    ),
    h('div', { class: 'status', id: 'status', role: 'status', 'aria-live': 'polite' }),
  );
  root.append(recCard);

  if (wavBlob || playbackUrl) {
    const playback = h('div', { class: 'playback' },
      h('p', { class: 'playback__label' }, '你的錄音：'),
      h('audio', { id: 'audio', controls: 'controls', src: playbackUrl }),
      h('p', { class: 'hint', id: 'audio-info' }),
    );
    if (wavBlob) {
      playback.append(
        h('button', { class: 'btn btn--ghost', id: 'btn-submit', onclick: submit },
          '🎯 檢查我的發音（選用）'),
        h('p', { class: 'hint' },
          '發音評分是輔助功能，需要伺服器設定好 Azure 或 Gemini 才能用。' +
          '單純想練習的話，聽示範 → 錄音 → 自己比對就很有幫助了。'),
      );
    }
    recCard.append(playback);
  }

  if (lastResult) {
    const fb = h('div', { class: 'card' }, h('p', { class: 'card__title' }, '發音講評'));
    renderAssessment(fb, lastResult, current.text, (el) => {
      const target = root.querySelector('#sentence');
      if (target) target.replaceWith(el);
    });
    root.append(fb);
  }
}

function setStatus(text, kind = '') {
  const el = root?.querySelector('#status');
  if (!el) return;
  el.textContent = text;
  el.className = 'status' + (kind ? ` status--${kind}` : '');
}

async function playDemo(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await speak(current.text);
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function toggleRecord() {
  if (recorder?.isRecording) return stopRecording();

  lastResult = null;
  wavBlob = null;
  revokePlayback();

  recorder = new Recorder({
    onTick: (sec) => {
      const t = root?.querySelector('#timer');
      if (t) t.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    },
    onAutoStop: () => { setStatus('已達最長錄音時間，自動停止。'); stopRecording(); },
  });

  setStatus('正在要求麥克風權限…');
  try {
    await recorder.start();
  } catch (err) {
    console.error('[getUserMedia]', err);
    setStatus(describeMicError(err), 'error');
    recorder = null;
    return;
  }

  setRecordingUI(true);
  setStatus(`錄音中，唸完後按「停止錄音」。（最長 ${MAX_RECORDING_MS / 1000} 秒）`);
}

async function stopRecording() {
  if (!recorder?.isRecording) return;
  setStatus('正在把錄音轉成 WAV…', 'busy');

  let result;
  try {
    result = await recorder.stop();
  } catch (err) {
    console.error('[錄音／轉換失敗]', err);
    setRecordingUI(false);
    if (err.raw) {
      // 轉換失敗仍讓使用者聽原始錄音，至少判斷得出有沒有錄到聲音
      playbackUrl = URL.createObjectURL(err.raw);
      render();
      setStatus(`錄音成功，但轉換成 WAV 失敗，無法送出分析。\n錯誤：${err.message}`, 'error');
    } else {
      setStatus(err.message, 'error');
    }
    return;
  }

  wavBlob = result.wav;
  playbackUrl = URL.createObjectURL(result.wav);
  setRecordingUI(false);

  const kb = (result.wav.size / 1024).toFixed(1);
  console.log(
    `[WAV] 原始錄音 ${result.recordedType} ${(result.raw.size / 1024).toFixed(1)} KB → ` +
    `WAV ${kb} KB / ${result.durationSec.toFixed(2)} 秒 / ${result.sampleRate} Hz 單聲道`
  );

  render();
  const info = root?.querySelector('#audio-info');
  if (info) {
    info.textContent = `WAV ${kb} KB・${result.durationSec.toFixed(2)} 秒・${result.sampleRate} Hz 單聲道（原始 ${result.recordedType}）`;
  }
  setStatus('錄好了！先聽聽看自己跟示範差在哪。');
}

function setRecordingUI(isRecording) {
  const btn = root?.querySelector('#btn-record');
  const label = root?.querySelector('#btn-record-label');
  const timer = root?.querySelector('#timer');
  btn?.classList.toggle('is-recording', isRecording);
  if (label) label.textContent = isRecording ? '停止錄音' : '開始錄音';
  if (timer) timer.hidden = !isRecording;
}

async function submit() {
  if (!wavBlob || !current) return;
  const btn = root?.querySelector('#btn-submit');
  if (btn) btn.disabled = true;
  setStatus('分析中，請稍候…', 'busy');

  const form = new FormData();
  form.append('audio', wavBlob, 'recording.wav');
  form.append('sentence', current.text);

  try {
    const res = await fetch('/api/pronunciation-feedback', { method: 'POST', body: form });
    const payload = await res.json().catch(() => null);

    if (!res.ok) {
      setStatus(payload?.message ?? `伺服器回了 HTTP ${res.status}，請稍後再試一次。`, 'error');
      return;
    }

    lastResult = payload;
    addAttempt({
      sentenceId: current.id,
      text: current.text,
      score: payload.scores?.pronunciation ?? payload.score ?? null,
      provider: payload.provider ?? 'unknown',
    });
    render();
    setStatus('');
  } catch (err) {
    console.error('[submit]', err);
    setStatus('連不上伺服器。請確認後端還在執行（npm start 沒有中斷），再試一次。', 'error');
  } finally {
    const b = root?.querySelector('#btn-submit');
    if (b) b.disabled = false;
  }
}
