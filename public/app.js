import { blobToWav } from './wav-encoder.js';
import { createWaveform } from './waveform.js';
import {
  storageAvailable,
  loadHistory,
  addRecord,
  clearHistory,
  summarise,
  loadPrefs,
  savePrefs,
} from './storage.js';

const $ = (id) => document.getElementById(id);

const el = {
  fatal: $('fatal'),
  sentence: $('sentence'),
  category: $('category'),
  difficulty: $('difficulty'),
  filterCategory: $('filter-category'),
  filterDifficulty: $('filter-difficulty'),
  filterCount: $('filter-count'),
  btnSpeak: $('btn-speak'),
  btnNext: $('btn-next'),
  btnRecord: $('btn-record'),
  btnRecordLabel: $('btn-record-label'),
  btnSubmit: $('btn-submit'),
  timer: $('timer'),
  level: $('level'),
  levelFill: $('level-fill'),
  levelText: $('level-text'),
  waveform: $('waveform'),
  status: $('status'),
  playback: $('playback'),
  audio: $('audio'),
  audioInfo: $('audio-info'),
  model: $('model'),
  modelNote: $('model-note'),
  feedbackCard: $('feedback-card'),
  feedback: $('feedback'),
  historyCard: $('history-card'),
  historyStats: $('history-stats'),
  historyList: $('history-list'),
  btnClearHistory: $('btn-clear-history'),
};

const CATEGORY_LABEL = { daily: '日常對話', interview: '面試', travel: '旅遊' };
const DIFFICULTY_LABEL = { easy: '簡單', medium: '中等', hard: '困難' };
// 難度下拉選單要照這個順序排，直接用 Object.keys 會變成 sentences.json 的出現順序
const DIFFICULTY_ORDER = ['easy', 'medium', 'hard'];

const MAX_RECORDING_MS = 60_000;

let sentences = [];
let current = null;
let recorder = null;
let stream = null;
let chunks = [];
let timerId = null;
let autoStopId = null;
let startedAt = 0;
let wavBlob = null;
let wavStats = null;
let playbackUrl = null;
let models = [];
let history = [];
// 瀏覽器不支援錄音時 fatal() 會停用錄音鍵，之後換句子不可以再把它打開
let browserSupported = true;

const waveform = createWaveform(el.waveform, showLevel);

// ─── 狀態訊息 ────────────────────────────────────────────────────────────
function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = 'status' + (kind ? ` status--${kind}` : '');
}

function fatal(message) {
  el.fatal.textContent = message;
  el.fatal.hidden = false;
  browserSupported = false;
  el.btnRecord.disabled = true;
}

// ─── 階段 1：例句 ────────────────────────────────────────────────────────
async function loadSentences() {
  const res = await fetch('/api/sentences');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  sentences = await res.json();
  if (!Array.isArray(sentences) || sentences.length === 0) {
    throw new Error('sentences.json 是空的');
  }
}

// ─── 階段 5：依情境／難度篩選 ────────────────────────────────────────────
// 選項是從 sentences.json 實際出現的值長出來的，不是寫死的清單 ——
// 之後在 sentences.json 加新的 category 不用回來改前端。

function buildFilterOptions() {
  const categories = [...new Set(sentences.map((s) => s.category).filter(Boolean))];
  const difficulties = [...new Set(sentences.map((s) => s.difficulty).filter(Boolean))].sort(
    (a, b) => DIFFICULTY_ORDER.indexOf(a) - DIFFICULTY_ORDER.indexOf(b)
  );

  const fill = (select, values, labels) => {
    select.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = '全部';
    select.append(all);
    for (const value of values) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = labels[value] ?? value;
      select.append(option);
    }
  };

  fill(el.filterCategory, categories, CATEGORY_LABEL);
  fill(el.filterDifficulty, difficulties, DIFFICULTY_LABEL);

  // 還原上次選的條件。值可能已經不存在（sentences.json 改過），所以要確認選得上。
  const prefs = loadPrefs();
  if (categories.includes(prefs.category)) el.filterCategory.value = prefs.category;
  if (difficulties.includes(prefs.difficulty)) el.filterDifficulty.value = prefs.difficulty;
}

function filteredSentences() {
  const category = el.filterCategory.value;
  const difficulty = el.filterDifficulty.value;
  return sentences.filter(
    (s) => (!category || s.category === category) && (!difficulty || s.difficulty === difficulty)
  );
}

function onFilterChange() {
  savePrefs({
    category: el.filterCategory.value,
    difficulty: el.filterDifficulty.value,
  });
  showRandomSentence();
}

function showRandomSentence() {
  const pool = filteredSentences();
  el.filterCount.textContent = `符合條件 ${pool.length} / ${sentences.length} 句`;

  if (pool.length === 0) {
    // 條件組合不存在時要講清楚，不要留一個空白的句子讓人以為壞了
    current = null;
    el.sentence.textContent = '這個組合沒有練習句';
    el.category.textContent = '';
    el.difficulty.textContent = '';
    el.btnSpeak.disabled = true;
    el.btnRecord.disabled = true;
    resetRecording();
    setStatus('請放寬情境或難度的條件，才有句子可以練習。', 'error');
    return;
  }

  el.btnSpeak.disabled = false;
  el.btnRecord.disabled = !browserSupported;

  let next = current;
  // 池子多於一句時，避免連續抽到同一句
  while (pool.length > 1 && next?.id === current?.id) {
    next = pool[Math.floor(Math.random() * pool.length)];
  }
  // 池子只剩一句，或原本的句子已經不在池子裡，就直接用第一句
  current = pool.includes(next) ? next : pool[0];

  el.sentence.textContent = current.text;
  el.category.textContent = CATEGORY_LABEL[current.category] ?? current.category;
  el.difficulty.textContent =
    DIFFICULTY_LABEL[current.difficulty] ?? current.difficulty;

  resetRecording();
}

// ─── 階段 1：播放正確發音（speechSynthesis）─────────────────────────────
// 踩雷清單 #3：getVoices() 第一次呼叫常常回空陣列，voice 清單是非同步載入的。
// 同時監聽 voiceschanged 並做 polling 重試，兩邊誰先到就用誰。
function loadVoices(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const immediate = speechSynthesis.getVoices();
    if (immediate.length) return resolve(immediate);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(pollId);
      speechSynthesis.removeEventListener('voiceschanged', finish);
      resolve(speechSynthesis.getVoices());
    };

    speechSynthesis.addEventListener('voiceschanged', finish);

    const deadline = Date.now() + timeoutMs;
    const pollId = setInterval(() => {
      if (speechSynthesis.getVoices().length || Date.now() > deadline) finish();
    }, 100);
  });
}

async function speakCurrentSentence() {
  if (!('speechSynthesis' in window)) {
    setStatus('這個瀏覽器不支援語音合成，無法播放示範發音。建議改用 Chrome 或 Edge。', 'error');
    return;
  }
  if (!current) return;

  speechSynthesis.cancel();
  const voices = await loadVoices();
  const englishVoices = voices.filter((v) => v.lang?.startsWith('en'));

  if (voices.length === 0) {
    setStatus(
      '瀏覽器還沒載入任何語音，請稍等一下再按一次。若一直沒有，請確認系統已安裝語音包。',
      'error'
    );
    return;
  }
  if (englishVoices.length === 0) {
    setStatus('系統裡找不到英語語音，請到作業系統的語音設定安裝英語語音包。', 'error');
    return;
  }

  // 優先挑 en-US，其次任何英語語音
  const voice =
    englishVoices.find((v) => v.lang === 'en-US') ?? englishVoices[0];

  const utterance = new SpeechSynthesisUtterance(current.text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = 0.9;
  utterance.onerror = (e) => {
    if (e.error === 'interrupted' || e.error === 'canceled') return;
    setStatus(`播放示範發音失敗（${e.error}），請再試一次。`, 'error');
  };
  speechSynthesis.speak(utterance);
}

// ─── 階段 2：錄音 ────────────────────────────────────────────────────────
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

function describeMicError(err) {
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
      return (
        '麥克風被其他程式占用了（例如視訊會議軟體）。\n請關掉那個程式後再試一次。'
      );
    case 'OverconstrainedError':
      return '找不到符合條件的麥克風裝置，請改用系統預設的麥克風。';
    case 'SecurityError':
      return '瀏覽器基於安全性擋下了麥克風，請確認你是從 localhost 開啟這個頁面。';
    default:
      return `無法開啟麥克風（${err?.name || '未知錯誤'}）：${err?.message || ''}`;
  }
}

async function startRecording() {
  resetRecording();
  setStatus('正在要求麥克風權限…');

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error('[getUserMedia]', err);
    setStatus(describeMicError(err), 'error');
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
    setStatus(
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
    setStatus('錄音過程中發生錯誤，請重新錄一次。', 'error');
    stopStream();
    setRecordingUI(false);
  });
  recorder.addEventListener('stop', handleRecordingStopped);

  recorder.start();
  startedAt = Date.now();
  setRecordingUI(true);
  // 階段 5：即時波形。畫不出來也不影響錄音，所以失敗就算了。
  waveform.start(stream);
  setStatus(`錄音中，唸完後按「停止錄音」。（最長 ${MAX_RECORDING_MS / 1000} 秒）`);

  timerId = setInterval(updateTimer, 200);
  autoStopId = setTimeout(() => {
    if (recorder?.state === 'recording') {
      setStatus('已達最長錄音時間，自動停止。');
      recorder.stop();
    }
  }, MAX_RECORDING_MS);
}

function stopRecording() {
  if (recorder?.state === 'recording') recorder.stop();
}

async function handleRecordingStopped() {
  clearInterval(timerId);
  clearTimeout(autoStopId);
  setRecordingUI(false);
  // 先停波形再關 stream —— 反過來的話 AnalyserNode 會讀到已經結束的 track
  waveform.stop();
  stopStream();

  const recordedType = recorder?.mimeType || chunks[0]?.type || 'audio/webm';
  const raw = new Blob(chunks, { type: recordedType });

  if (raw.size === 0) {
    setStatus('沒有錄到任何聲音，請確認麥克風有在運作後再試一次。', 'error');
    return;
  }

  setStatus('正在把錄音轉成 WAV…', 'busy');

  try {
    // §2.3：不要把 webm 直接送給 API，一律轉成 16 kHz 單聲道 WAV。
    const result = await blobToWav(raw);
    wavBlob = result.blob;
    wavStats = result.stats;

    const kb = (wavBlob.size / 1024).toFixed(1);
    const seconds = result.durationSec.toFixed(2);

    // 階段 2 驗收項目：console 印出轉換後的大小與長度
    console.log(
      `[WAV] 原始錄音 ${recordedType} ${(raw.size / 1024).toFixed(1)} KB → ` +
        `WAV ${kb} KB / ${seconds} 秒 / ${result.sampleRate} Hz 單聲道`
    );
    console.log(
      `[音量] peak=${wavStats.peak.toFixed(4)} rms=${wavStats.rms.toFixed(4)} ` +
        `有聲比例=${(wavStats.voicedRatio * 100).toFixed(1)}% 起伏=${wavStats.flatness.toFixed(3)}`
    );

    showPlayback(wavBlob);
    el.audioInfo.textContent = `WAV ${kb} KB・${seconds} 秒・${result.sampleRate} Hz 單聲道（原始 ${recordedType}）`;

    // 階段 5：沒有人聲就別讓它送出去。
    // 後端也會擋（server/audio.js），這裡擋是為了立刻給回饋、順便省一次上傳。
    if (wavStats.silent) {
      el.btnSubmit.disabled = true;
      setStatus(
        '這段錄音裡幾乎沒有聲音，送出去也分析不了。\n' +
          '請確認麥克風沒有被靜音、系統選到的輸入裝置是對的，然後靠近一點重錄。',
        'error'
      );
    } else if (wavStats.quiet) {
      setStatus('錄好了，不過音量偏小，可以再靠近麥克風一點。要送出也沒問題。');
    } else {
      setStatus('錄好了！先聽聽看，沒問題就送出。');
    }
  } catch (err) {
    console.error('[WAV 轉換失敗]', err);
    // 轉換失敗時仍讓使用者聽原始錄音，至少能判斷錄音本身有沒有問題
    wavBlob = null;
    wavStats = null;
    showPlayback(raw);
    el.audioInfo.textContent = `原始錄音 ${(raw.size / 1024).toFixed(1)} KB（${recordedType}）`;
    el.btnSubmit.disabled = true;
    setStatus(
      '錄音成功，但轉換成 WAV 時失敗，所以無法送出分析。\n' +
        `你仍可以播放上面的原始錄音確認有錄到聲音。錯誤：${err.message}`,
      'error'
    );
  }
}

function showPlayback(blob) {
  if (playbackUrl) URL.revokeObjectURL(playbackUrl);
  playbackUrl = URL.createObjectURL(blob);
  el.audio.src = playbackUrl;
  el.playback.hidden = false;
  el.btnSubmit.disabled = false;
}

function setRecordingUI(isRecording) {
  el.btnRecord.classList.toggle('is-recording', isRecording);
  el.btnRecordLabel.textContent = isRecording ? '停止錄音' : '開始錄音';
  el.timer.hidden = !isRecording;
  el.level.hidden = !isRecording;
  el.btnNext.disabled = isRecording;
  el.btnSpeak.disabled = isRecording;
  el.filterCategory.disabled = isRecording;
  el.filterDifficulty.disabled = isRecording;
}

/**
 * 即時音量指示（由 waveform 的 onLevel 每一幀呼叫）。
 * 目的是讓使用者在錄音當下就知道麥克風有沒有在收音，
 * 而不是錄完送出後才被「沒有偵測到人聲」擋下來。
 */
function showLevel(peak) {
  const percent = Math.min(100, Math.round(peak * 140));
  el.levelFill.style.width = `${percent}%`;
  el.levelFill.classList.toggle('level__fill--low', peak < 0.02);
  el.levelText.textContent = peak < 0.02 ? '幾乎沒收到聲音' : '收音中';
}

function updateTimer() {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  el.timer.textContent = `${mm}:${ss}`;
}

function stopStream() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

function resetRecording() {
  stopStream();
  waveform.reset();
  clearInterval(timerId);
  clearTimeout(autoStopId);
  chunks = [];
  wavBlob = null;
  wavStats = null;
  recorder = null;
  el.playback.hidden = true;
  el.feedbackCard.hidden = true;
  el.timer.textContent = '00:00';
  el.btnSubmit.disabled = false;
  setRecordingUI(false);
  setStatus('');
  if (playbackUrl) {
    URL.revokeObjectURL(playbackUrl);
    playbackUrl = null;
    el.audio.removeAttribute('src');
  }
}

// ─── 階段 2：送到後端（此時後端回假資料）─────────────────────────────────
async function submitRecording() {
  if (!wavBlob || !current) return;

  // 前端這關擋掉明顯沒聲音的錄音，省下一次上傳與 API 呼叫。
  // 真正的把關在後端（server/audio.js）—— 前端的判斷不能當作保證。
  if (wavStats?.silent) {
    setStatus(
      '這段錄音裡幾乎沒有聲音，請重新錄一次再送出。',
      'error'
    );
    return;
  }

  el.btnSubmit.disabled = true;
  setStatus('分析中，請稍候…', 'busy');

  const form = new FormData();
  form.append('audio', wavBlob, 'recording.wav');
  form.append('sentence', current.text);
  if (el.model.value) form.append('model', el.model.value);

  try {
    const res = await fetch('/api/pronunciation-feedback', {
      method: 'POST',
      body: form,
    });

    const payload = await res.json().catch(() => null);

    if (!res.ok) {
      setStatus(
        payload?.message ?? `伺服器回了 HTTP ${res.status}，請稍後再試一次。`,
        'error'
      );
      el.btnSubmit.disabled = false;
      return;
    }

    renderFeedback(payload);
    // 後端判定沒有人聲時不算一次練習，不要拿 0 分去汙染平均分數
    if (payload?.speech_detected === false) {
      setStatus('');
    } else {
      saveToHistory(payload);
      setStatus('');
    }
  } catch (err) {
    console.error('[submit]', err);
    setStatus(
      '連不上伺服器。請確認後端還在執行（終端機裡的 npm start 沒有中斷），再試一次。',
      'error'
    );
  } finally {
    el.btnSubmit.disabled = false;
  }
}

// ─── 階段 4：transcript 與目標句逐字比對 ────────────────────────────────
// 用 LCS（最長共同子序列）找出對得上的字，對不上的就標色。
// 不需要很精準 —— 目的是讓使用者一眼看到哪幾個字沒唸到或唸錯。
function normalizeWord(w) {
  return w.toLowerCase().replace(/[^a-z0-9']/g, '');
}

function matchedTargetIndices(targetWords, spokenWords) {
  const a = targetWords.map(normalizeWord);
  const b = spokenWords.map(normalizeWord);
  // dp[i][j] = a[i..] 與 b[j..] 的 LCS 長度
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matched = new Set();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      matched.add(i);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return matched;
}

function highlightSentence(transcript, problemWords = []) {
  if (!current) return;
  const targetWords = current.text.split(/\s+/);
  const matched = matchedTargetIndices(targetWords, (transcript || '').split(/\s+/));
  const problems = new Set(problemWords.map(normalizeWord).filter(Boolean));

  el.sentence.replaceChildren();
  targetWords.forEach((word, idx) => {
    const span = document.createElement('span');
    span.textContent = word;
    // 沒被聽到，或被 Gemini 點名發音有問題 → 標色
    if (!matched.has(idx) || problems.has(normalizeWord(word))) {
      span.className = 'word--miss';
      span.title = !matched.has(idx) ? '這個字沒有聽到，或唸得不一樣' : '這個字的發音需要加強';
    }
    el.sentence.append(span);
    if (idx < targetWords.length - 1) el.sentence.append(' ');
  });
}

function renderFeedback(data) {
  el.feedback.replaceChildren();

  // 沒偵測到人聲：不要顯示「0 分」，那看起來像是發音很爛，
  // 實際上是根本沒錄到東西 —— 兩件事給使用者的訊息完全不同。
  if (data?.speech_detected === false) {
    const body = document.createElement('p');
    body.style.whiteSpace = 'pre-wrap';
    body.textContent = data.feedback_zh ?? '沒有偵測到人聲，請重新錄音。';
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = '這次不會計入練習紀錄。';
    el.feedback.append(body, note);
    el.feedbackCard.hidden = false;
    return;
  }

  if (data?.transcript) {
    highlightSentence(data.transcript, data.problem_words);
  }

  if (typeof data?.score === 'number') {
    const score = document.createElement('p');
    score.innerHTML = `<strong>參考分數：${data.score} / 100</strong>`;
    const disclaimer = document.createElement('p');
    disclaimer.className = 'hint';
    disclaimer.textContent =
      '這是 AI 的主觀評估，僅供參考，不是標準化測驗分數。';
    el.feedback.append(score, disclaimer);
  }

  if (data?.transcript) {
    const t = document.createElement('p');
    t.className = 'hint';
    t.textContent = `AI 聽到的內容：${data.transcript}`;
    const legend = document.createElement('p');
    legend.className = 'hint';
    legend.textContent = '上方句子中標紅的字，是沒被聽到、或發音需要加強的部分。';
    el.feedback.append(t, legend);
  }

  const body = document.createElement('p');
  body.style.whiteSpace = 'pre-wrap';
  body.textContent = data?.feedback_zh ?? '（沒有收到講評內容）';
  el.feedback.append(body);

  if (data?.model) {
    const by = document.createElement('p');
    by.className = 'hint';
    by.textContent = `由 ${labelForModel(data.model)} 評分`;
    el.feedback.append(by);
  }

  el.feedbackCard.hidden = false;
}

// ─── 階段 5：model 選單 ──────────────────────────────────────────────────
// 清單由後端的 /api/models 提供。前端不自己寫死 model 名稱，
// 後端也會用同一份白名單驗證送上來的值 —— 選單只是 UI，不是權限。

async function loadModels() {
  const res = await fetch('/api/models');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  models = Array.isArray(payload.models) ? payload.models : [];
  if (models.length === 0) throw new Error('後端沒有回傳任何可用的 model');

  el.model.replaceChildren();
  for (const m of models) {
    const option = document.createElement('option');
    option.value = m.id;
    option.textContent = m.label ?? m.id;
    el.model.append(option);
  }

  // 上次選的優先，其次後端給的預設值
  const preferred = loadPrefs().model;
  el.model.value = models.some((m) => m.id === preferred) ? preferred : payload.default;
  if (!el.model.value) el.model.value = models[0].id;
  updateModelNote();
}

function labelForModel(id) {
  return models.find((m) => m.id === id)?.label ?? id;
}

function updateModelNote() {
  const chosen = models.find((m) => m.id === el.model.value);
  el.modelNote.textContent = chosen?.note ?? '';
}

function onModelChange() {
  savePrefs({ model: el.model.value });
  updateModelNote();
}

// ─── 階段 5：練習紀錄 ────────────────────────────────────────────────────

function saveToHistory(data) {
  if (!current || typeof data?.score !== 'number') return;

  history = addRecord({
    at: new Date().toISOString(),
    sentenceId: current.id,
    sentenceText: current.text,
    category: current.category,
    difficulty: current.difficulty,
    score: data.score,
    transcript: data.transcript ?? '',
    problemWords: Array.isArray(data.problem_words) ? data.problem_words : [],
    model: data.model ?? el.model.value,
  });
  renderHistory();
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = new Date().toDateString() === date.toDateString();
  const time = date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `今天 ${time}`;
  return `${date.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })} ${time}`;
}

function scoreClass(score) {
  if (score >= 80) return 'score--good';
  if (score >= 60) return 'score--ok';
  return 'score--low';
}

function renderHistory() {
  if (history.length === 0) {
    el.historyCard.hidden = true;
    return;
  }
  el.historyCard.hidden = false;

  const stats = summarise(history);
  el.historyStats.replaceChildren();
  const tiles = [
    ['練習次數', String(stats.count)],
    ['平均分數', stats.average === null ? '—' : String(stats.average)],
    ['最高分', stats.best === null ? '—' : String(stats.best)],
  ];
  for (const [label, value] of tiles) {
    const tile = document.createElement('div');
    tile.className = 'stat';
    const v = document.createElement('span');
    v.className = 'stat__value';
    v.textContent = value;
    const l = document.createElement('span');
    l.className = 'stat__label';
    l.textContent = label;
    tile.append(v, l);
    el.historyStats.append(tile);
  }

  // 只列最近 20 筆，再多就變成一整頁捲不完的清單
  el.historyList.replaceChildren();
  for (const record of history.slice(0, 20)) {
    const item = document.createElement('li');
    item.className = 'history__item';

    const score = document.createElement('span');
    score.className = `history__score ${scoreClass(record.score)}`;
    score.textContent = record.score;

    const main = document.createElement('div');
    main.className = 'history__main';

    const text = document.createElement('span');
    text.className = 'history__sentence';
    text.textContent = record.sentenceText ?? '';

    const meta = document.createElement('span');
    meta.className = 'history__meta';
    meta.textContent = [
      formatTime(record.at),
      CATEGORY_LABEL[record.category] ?? record.category,
      labelForModel(record.model),
    ]
      .filter(Boolean)
      .join('・');

    main.append(text, meta);
    item.append(score, main);
    el.historyList.append(item);
  }

  if (history.length > 20) {
    const more = document.createElement('li');
    more.className = 'hint';
    more.textContent = `另有 ${history.length - 20} 筆較早的紀錄未顯示。`;
    el.historyList.append(more);
  }
}

function onClearHistory() {
  if (history.length === 0) return;
  if (!window.confirm(`確定要刪掉全部 ${history.length} 筆練習紀錄嗎？這個動作無法復原。`)) {
    return;
  }
  clearHistory();
  history = [];
  renderHistory();
}

// ─── 啟動 ────────────────────────────────────────────────────────────────
function checkBrowserSupport() {
  if (!navigator.mediaDevices?.getUserMedia) {
    fatal(
      '這個瀏覽器不支援麥克風錄音（getUserMedia）。\n' +
        '常見原因是網址不是 localhost —— 麥克風需要 secure context，' +
        '用區網 IP（例如 192.168.x.x）開啟會失效。請改用 http://localhost:3000。'
    );
    return false;
  }
  if (typeof MediaRecorder === 'undefined') {
    fatal('這個瀏覽器不支援 MediaRecorder，無法錄音。建議改用最新版的 Chrome、Edge 或 Safari。');
    return false;
  }
  return true;
}

el.btnSpeak.addEventListener('click', speakCurrentSentence);
el.btnNext.addEventListener('click', showRandomSentence);
el.btnSubmit.addEventListener('click', submitRecording);
el.btnRecord.addEventListener('click', () => {
  if (recorder?.state === 'recording') stopRecording();
  else startRecording();
});
el.filterCategory.addEventListener('change', onFilterChange);
el.filterDifficulty.addEventListener('change', onFilterChange);
el.model.addEventListener('change', onModelChange);
el.btnClearHistory.addEventListener('click', onClearHistory);

// 離開頁面時確實釋放麥克風與 AudioContext
window.addEventListener('pagehide', () => {
  waveform.stop();
  stopStream();
});

(async function init() {
  const supported = checkBrowserSupport();

  try {
    await loadSentences();
    buildFilterOptions();
    showRandomSentence();
  } catch (err) {
    console.error('[loadSentences]', err);
    el.sentence.textContent = '載入例句失敗';
    setStatus(
      '讀不到練習句。請確認後端有在執行（npm start），並重新整理頁面。',
      'error'
    );
    return;
  }

  // model 清單拿不到不是致命錯誤 —— 收起選單，讓後端用它的預設值就好。
  try {
    await loadModels();
  } catch (err) {
    console.error('[loadModels]', err);
    el.model.closest('.field').hidden = true;
    el.modelNote.textContent = '讀不到可用的 model 清單，將使用伺服器的預設值。';
  }

  history = loadHistory();
  renderHistory();
  if (!storageAvailable()) {
    console.warn('[storage] localStorage 不可用，這次的練習紀錄與偏好設定不會被保存');
  }

  if (supported) {
    // 提早暖機 voice 清單，避免第一次按播放沒聲音
    loadVoices().catch(() => {});
  }
})();
