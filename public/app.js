// 主控：把「例句 → 錄音 → 送出 → 講評 → 紀錄」這條流程接起來。
//
// 這個檔案刻意只留下**流程與畫面狀態**，其他都在旁邊的模組裡：
//   recorder.js      麥克風、MediaRecorder、WAV 轉檔（不碰 DOM）
//   api.js           後端呼叫與錯誤訊息
//   speech.js        示範發音
//   practice.js      抽句加權、依句子彙整成績（純函式，有單元測試）
//   text-diff.js     目標句與 transcript 的逐字比對（純函式，有單元測試）
//   feedback-view.js 講評卡片
//   history-view.js  練習紀錄卡片與趨勢圖
//   trend-chart.js   趨勢圖的 SVG
//   labels.js        顯示字串與分數門檻

import { createWaveform } from './waveform.js';
import { createRecorder } from './recorder.js';
import { fetchSentences, fetchModels, submitFeedback } from './api.js';
import { speak, loadVoices } from './speech.js';
import {
  storageAvailable,
  loadHistory,
  addRecord,
  clearHistory,
  loadPrefs,
  savePrefs,
} from './storage.js';
import { sentenceStats, pickSentence } from './practice.js';
import { renderFeedback } from './feedback-view.js';
import { renderHistory } from './history-view.js';
import { categoryLabel, difficultyLabel, DIFFICULTY_ORDER, CATEGORY_LABEL, DIFFICULTY_LABEL } from './labels.js';

const $ = (id) => document.getElementById(id);

const el = {
  fatal: $('fatal'),
  sentence: $('sentence'),
  category: $('category'),
  difficulty: $('difficulty'),
  filterCategory: $('filter-category'),
  filterDifficulty: $('filter-difficulty'),
  filterCount: $('filter-count'),
  prefWeighted: $('pref-weighted'),
  sentencePast: $('sentence-past'),
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
  historyTrend: $('history-trend'),
  trendCaption: $('trend-caption'),
  trendChart: $('trend-chart'),
  btnClearHistory: $('btn-clear-history'),
};

const historyEl = {
  card: el.historyCard,
  stats: el.historyStats,
  list: el.historyList,
  trend: el.historyTrend,
  caption: el.trendCaption,
  chart: el.trendChart,
};

const feedbackEl = {
  card: el.feedbackCard,
  body: el.feedback,
  sentence: el.sentence,
};

let sentences = [];
let current = null;
let wavBlob = null;
let wavStats = null;
let playbackUrl = null;
let models = [];
let history = [];
// 依句子彙整的練習成績。history 一變就跟著重算，抽句加權與句子旁的
// 「練過幾次」都讀這份，不要各自再算一次。
let stats = new Map();
// 瀏覽器不支援錄音時 fatal() 會停用錄音鍵，之後換句子不可以再把它打開
let browserSupported = true;

const waveform = createWaveform(el.waveform, showLevel);

const recorder = createRecorder({
  waveform,
  onStatus: setStatus,
  onRecordingChange: setRecordingUI,
  onTick: updateTimer,
  onResult: handleRecordingResult,
});

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

// ─── 例句與篩選 ──────────────────────────────────────────────────────────
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
  // 沒存過偏好時預設開啟；只有明確存成 false 才關掉
  el.prefWeighted.checked = prefs.weighted !== false;
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

function onWeightedChange() {
  savePrefs({ weighted: el.prefWeighted.checked });
  // 不立刻換句 —— 使用者可能正想練現在這句，換掉會很煩。下一次「換一句」才生效。
  setStatus(
    el.prefWeighted.checked
      ? '之後換句時會優先抽出你分數比較低的句子。'
      : '之後換句時會從符合條件的句子裡等機率隨機抽。'
  );
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
    el.sentencePast.hidden = true;
    el.btnSpeak.disabled = true;
    el.btnRecord.disabled = true;
    resetRecording();
    setStatus('請放寬情境或難度的條件，才有句子可以練習。', 'error');
    return;
  }

  // 加權抽句的規則在 practice.js，這裡只負責把目前的狀態餵進去。
  // 關掉開關就退回等機率隨機 —— 「怎麼一直抽到同幾句」要有辦法關掉。
  current = pickSentence(pool, {
    stats,
    weighted: el.prefWeighted.checked,
    excludeId: current?.id ?? null,
  });

  renderCurrentSentence();
}

/** 把 `current` 畫到畫面上。抽到的、或從紀錄裡指定重練的，都走這裡。 */
function renderCurrentSentence() {
  if (!current) return;

  el.btnSpeak.disabled = false;
  el.btnRecord.disabled = !browserSupported;

  el.sentence.textContent = current.text;
  el.category.textContent = categoryLabel(current.category);
  el.difficulty.textContent = difficultyLabel(current.difficulty);
  renderPastChip();

  resetRecording();
}

/**
 * 句子旁邊顯示這句以前練得怎麼樣。
 *
 * 這也是加權抽句唯一看得見的地方 —— 沒有它的話，「為什麼又是這句」
 * 只會像是隨機抽壞了，而不是「因為你這句只有 42 分」。
 */
function renderPastChip() {
  const stat = current ? stats.get(current.id) : null;
  if (!stat) {
    el.sentencePast.hidden = true;
    el.sentencePast.textContent = '';
    return;
  }
  el.sentencePast.hidden = false;
  el.sentencePast.textContent =
    stat.count === 1
      ? `練過 1 次・${stat.last} 分`
      : `練過 ${stat.count} 次・平均 ${stat.average} 分`;
}

/** 從練習紀錄指定重練某一句。找不到就當作沒按（sentences.json 可能改過）。 */
function practiseSentence(id) {
  const target = sentences.find((s) => s.id === id);
  if (!target) return;

  current = target;
  renderCurrentSentence();

  // 篩選條件不動 —— 偷偷改掉使用者選的條件比句子跑出範圍更難理解。
  // 但要講清楚，不然按「換一句」時會覺得句子莫名其妙跳走。
  if (!filteredSentences().some((s) => s.id === id)) {
    setStatus('這句不在目前的篩選條件內；按「換一句」就會回到符合條件的句子。');
  }
  el.sentence.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─── 示範發音 ────────────────────────────────────────────────────────────
async function speakCurrentSentence() {
  if (!current) return;
  const problem = await speak(current.text, {
    onError: (message) => setStatus(message, 'error'),
  });
  if (problem) setStatus(problem, 'error');
}

// ─── 錄音的畫面部分 ──────────────────────────────────────────────────────

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
  el.prefWeighted.disabled = isRecording;
  // 錄音中按「重練這句」會把正在錄的句子換掉，錄完的音就對不上目標句了
  for (const btn of el.historyList.querySelectorAll('.history__replay')) {
    btn.disabled = isRecording;
  }
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

function updateTimer(elapsedSec = 0) {
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
  const ss = String(elapsedSec % 60).padStart(2, '0');
  el.timer.textContent = `${mm}:${ss}`;
}

/** 錄音器轉檔完成（或轉檔失敗）之後的畫面處理。 */
function handleRecordingResult({ raw, recordedType, wav, error }) {
  if (error || !wav) {
    // 轉換失敗時仍讓使用者聽原始錄音，至少能判斷錄音本身有沒有問題
    wavBlob = null;
    wavStats = null;
    showPlayback(raw);
    el.audioInfo.textContent = `原始錄音 ${(raw.size / 1024).toFixed(1)} KB（${recordedType}）`;
    el.btnSubmit.disabled = true;
    setStatus(
      '錄音成功，但轉換成 WAV 時失敗，所以無法送出分析。\n' +
        `你仍可以播放上面的原始錄音確認有錄到聲音。錯誤：${error?.message ?? '未知錯誤'}`,
      'error'
    );
    return;
  }

  wavBlob = wav.blob;
  wavStats = wav.stats;

  const kb = (wavBlob.size / 1024).toFixed(1);
  const seconds = wav.durationSec.toFixed(2);

  showPlayback(wavBlob);
  el.audioInfo.textContent =
    `WAV ${kb} KB・${seconds} 秒・${wav.sampleRate} Hz 單聲道（原始 ${recordedType}）`;

  // 沒有人聲就別讓它送出去。
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
}

function resetRecording() {
  recorder.reset();
  wavBlob = null;
  wavStats = null;
  el.playback.hidden = true;
  el.feedbackCard.hidden = true;
  el.timer.textContent = '00:00';
  el.btnSubmit.disabled = false;
  setStatus('');
  if (playbackUrl) {
    URL.revokeObjectURL(playbackUrl);
    playbackUrl = null;
    el.audio.removeAttribute('src');
  }
}

// ─── 送出分析 ────────────────────────────────────────────────────────────
async function submitRecording() {
  if (!wavBlob || !current) return;

  // 前端這關擋掉明顯沒聲音的錄音，省下一次上傳與 API 呼叫。
  // 真正的把關在後端（server/audio.js）—— 前端的判斷不能當作保證。
  if (wavStats?.silent) {
    setStatus('這段錄音裡幾乎沒有聲音，請重新錄一次再送出。', 'error');
    return;
  }

  el.btnSubmit.disabled = true;
  setStatus('分析中，請稍候…', 'busy');

  const result = await submitFeedback({
    wavBlob,
    sentence: current.text,
    model: el.model.value,
  });

  el.btnSubmit.disabled = false;

  if (!result.ok) {
    setStatus(result.message, 'error');
    return;
  }

  renderFeedback(feedbackEl, result.data, {
    sentenceText: current.text,
    labelForModel,
  });
  setStatus('');

  // 後端判定沒有人聲時不算一次練習，不要拿 0 分去汙染平均分數
  if (result.data?.speech_detected !== false) saveToHistory(result.data);
}

// ─── model 選單 ──────────────────────────────────────────────────────────
// 清單由後端的 /api/models 提供。前端不自己寫死 model 名稱，
// 後端也會用同一份白名單驗證送上來的值 —— 選單只是 UI，不是權限。

async function loadModelOptions() {
  const payload = await fetchModels();
  models = payload.models;

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

// ─── 練習紀錄 ────────────────────────────────────────────────────────────

/** history 只從這裡改，順便重算 stats。 */
function setHistory(next) {
  history = next;
  stats = sentenceStats(history);
}

function saveToHistory(data) {
  if (!current || typeof data?.score !== 'number') return;

  setHistory(
    addRecord({
      at: new Date().toISOString(),
      sentenceId: current.id,
      sentenceText: current.text,
      category: current.category,
      difficulty: current.difficulty,
      score: data.score,
      transcript: data.transcript ?? '',
      problemWords: Array.isArray(data.problem_words) ? data.problem_words : [],
      model: data.model ?? el.model.value,
    })
  );
  drawHistory();
  // 剛練完的分數會影響這句的統計，chip 要跟著更新
  renderPastChip();
}

function drawHistory() {
  renderHistory(historyEl, {
    history,
    sentences,
    onReplay: practiseSentence,
    replayDisabled: recorder.isActive(),
    labelForModel,
  });
}

function onClearHistory() {
  if (history.length === 0) return;
  if (!window.confirm(`確定要刪掉全部 ${history.length} 筆練習紀錄嗎？這個動作無法復原。`)) {
    return;
  }
  clearHistory();
  setHistory([]);
  drawHistory();
  renderPastChip();
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
  if (recorder.isRecording()) recorder.stop();
  else recorder.start();
});
el.filterCategory.addEventListener('change', onFilterChange);
el.filterDifficulty.addEventListener('change', onFilterChange);
el.prefWeighted.addEventListener('change', onWeightedChange);
el.model.addEventListener('change', onModelChange);
el.btnClearHistory.addEventListener('click', onClearHistory);

// 離開頁面時確實釋放麥克風與 AudioContext
window.addEventListener('pagehide', () => {
  waveform.stop();
  recorder.stopStream();
});

(async function init() {
  const supported = checkBrowserSupport();

  // 紀錄要先讀進來，第一次抽句才有加權可用（localStorage 是同步的，不會拖慢載入）
  setHistory(loadHistory());
  if (!storageAvailable()) {
    console.warn('[storage] localStorage 不可用，這次的練習紀錄與偏好設定不會被保存');
  }

  try {
    sentences = await fetchSentences();
    buildFilterOptions();
    showRandomSentence();
  } catch (err) {
    console.error('[loadSentences]', err);
    el.sentence.textContent = '載入例句失敗';
    setStatus('讀不到練習句。請確認後端有在執行（npm start），並重新整理頁面。', 'error');
    return;
  }

  // model 清單拿不到不是致命錯誤 —— 收起選單，讓後端用它的預設值就好。
  try {
    await loadModelOptions();
  } catch (err) {
    console.error('[loadModels]', err);
    el.model.closest('.field').hidden = true;
    el.modelNote.textContent = '讀不到可用的 model 清單，將使用伺服器的預設值。';
  }

  // 紀錄清單要等 model 清單載入後才畫，meta 那行才顯示得出 model 的名稱
  drawHistory();

  if (supported) {
    // 提早暖機 voice 清單，避免第一次按播放沒聲音
    loadVoices().catch(() => {});
  }
})();
