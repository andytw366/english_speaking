// 跟讀：聽示範發音 → 錄下自己的版本 → 拿到逐音素的發音評估。
//
// 這個模式是兩個分支整合的落點。它比其他模式複雜，因為練習紀錄在這裡不只是
// 「看過的清單」—— 它會回頭決定下一句抽什麼：
//
//   分數低的 × 久沒練的 × 練得到你常錯的音的  →  比較常出現
//
// 三個維度的規則都在 lib/practice.js（純函式，有 60 多項單元測試釘住）。
// 這裡只負責把狀態餵進去，以及把結果畫出來。

import { h, append } from '../lib/dom.js';
import { columns } from '../lib/layout.js';
import { filterBySettings, getSettings, updateSettings } from '../lib/settings.js';
import { speak, isSupported as ttsSupported } from '../lib/tts.js';
import {
  Recorder, isSupported as recSupported, unsupportedReason,
  describeMicError, MAX_RECORDING_MS,
} from '../lib/recorder.js';
import { addAttempt, getHistory, clearHistory } from '../lib/storage.js';
import { createWaveform } from '../lib/waveform.js';
import { categoryLabel, difficultyLabel, issueLabel, relativeTime } from '../lib/labels.js';
import {
  sentenceStats, pickSentence, isDue, weakIssues, matchedWeakIssues,
  summariseSet, SET_SIZE,
} from '../lib/practice.js';
import { problemWordsFromAssessment, prosodyIssue } from '../lib/azure-issues.js';
import { renderAssessment } from './assessment-view.js';
import { renderToday, renderSetSummary, renderHistory } from './shadowing-views.js';
import { recordPractice } from '../lib/daily.js';
import { goalOf, setGoal } from '../lib/settings.js';

export const meta = { id: 'shadowing', label: '跟讀', icon: '🗣️' };

const DEFAULT_GOAL = SET_SIZE;

let allSentences = [];   // 句庫全部（「重練這句」要能跨過篩選條件）
let pool = [];           // 目前篩選條件內的句子
let current = null;
let recorder = null;
let waveform = null;
let waveformCanvas = null;   // render() 會重建 DOM，波形要跟著換到新的 canvas
let wavBlob = null;
let wavStats = null;
let playbackUrl = null;
let lastResult = null;
let history = [];
let stats = new Map();   // 依句子彙整的成績；history 一變就重算
let weak = new Map();    // 最近哪些音出問題出得最多
let setRecords = [];     // 這一組練到第幾句（只存在記憶體：一組是「這次坐下來練的」）
let lastSetSummary = null;
let outOfPoolNote = '';
let root = null;

// ─── 生命週期 ────────────────────────────────────────────────────────────

export async function mount(container) {
  root = container;

  const res = await fetch('/api/content/sentences');
  if (!res.ok) throw new Error(`讀取練習句失敗（HTTP ${res.status}）`);
  allSentences = await res.json();

  refreshPool();
  loadHistory();
  nextSentence();
  window.addEventListener('settings-changed', onSettingsChanged);
  return cleanup;
}

function cleanup() {
  window.removeEventListener('settings-changed', onSettingsChanged);
  recorder?.cleanup();
  recorder = null;
  waveform?.stop();
  waveform = null;
  waveformCanvas = null;
  revokePlayback();
  root = null;
}

function onSettingsChanged() {
  refreshPool();
  render();
}

/** 設定裡的情境／難度篩選。空的篩選代表全部。 */
function refreshPool() {
  const filtered = filterBySettings(allSentences);
  // 條件組合不存在時退回全部，不要讓使用者看到一個空模式
  pool = filtered.length > 0 ? filtered : allSentences;
}

function loadHistory() {
  history = getHistory();
  stats = sentenceStats(history);
  weak = weakIssues(history);
}

// ─── 抽句 ────────────────────────────────────────────────────────────────

function weightedEnabled() {
  // 沒存過偏好時預設開啟；只有明確存成 false 才關掉
  return getSettings().shadowingWeighted !== false;
}

function dailyGoal() {
  const saved = goalOf('shadowing');
  return saved > 0 ? saved : DEFAULT_GOAL;
}

function nextSentence() {
  outOfPoolNote = '';
  // 加權的規則在 practice.js，這裡只負責把目前的狀態餵進去。
  // 關掉開關就退回等機率隨機 —— 「怎麼一直抽到同幾句」要有辦法關掉。
  current = pickSentence(pool, {
    stats,
    weak: weightedEnabled() ? weak : null,
    weighted: weightedEnabled(),
    excludeId: current?.id ?? null,
  });
  resetAttempt();
}

/** 從練習紀錄指定重練某一句。找不到就當作沒按（句庫可能改過）。 */
function practiseSentence(id) {
  const target = allSentences.find((s) => s.id === id);
  if (!target) return;
  current = target;

  // 篩選條件不動 —— 偷偷改掉使用者選的條件比句子跑出範圍更難理解。
  // 但要講清楚，不然按「換一句」時會覺得句子莫名其妙跳走。
  outOfPoolNote = pool.some((s) => s.id === id)
    ? ''
    : '這句不在目前的篩選條件內；按「換一句」就會回到符合條件的句子。';
  resetAttempt();
  root?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetAttempt() {
  recorder?.cleanup();
  recorder = null;
  waveform?.reset();
  wavBlob = null;
  wavStats = null;
  lastResult = null;
  revokePlayback();
  render();
}

function revokePlayback() {
  if (playbackUrl) {
    URL.revokeObjectURL(playbackUrl);
    playbackUrl = null;
  }
}

// ─── 畫面 ────────────────────────────────────────────────────────────────

function render() {
  if (!root) return;
  // 這個模式最需要兩欄：**題目與自己的分數趨勢在單欄版本裡永遠不可能同時看到**
  // （紀錄永遠在折線下面），而「這句練得比上次好嗎」正是跟讀的重點。
  const { main, side } = columns(root);

  append(side, renderToday(dailyGoal(), (goal) => {
    setGoal('shadowing', goal);
    render();
  }));

  if (!current) {
    append(main, h('div', { class: 'banner banner--error' },
      '句庫是空的，或篩選條件把所有句子都排除了。請到「設定」放寬情境與難度。'));
    return;
  }

  append(main, sentenceCard(), recordCard());

  if (lastResult) {
    const card = h('div', { class: 'card' }, h('p', { class: 'card__title' }, '發音講評'));
    renderAssessment(card, lastResult, current.text, (el) => {
      const target = root.querySelector('#sentence');
      if (target) target.replaceWith(el);
    });
    append(main, card);
  }

  if (lastSetSummary) {
    append(main, renderSetSummary(lastSetSummary, () => {
      lastSetSummary = null;
      nextSentence();
    }));
  }

  append(side, renderHistory(history, {
    sentences: allSentences,
    onReplay: practiseSentence,
    onClear: onClearHistory,
    replayDisabled: Boolean(recorder?.isRecording),
  }));
}

function sentenceCard() {
  const stat = stats.get(current.id);
  const since = stat ? relativeTime(stat.lastAt) : '';
  const due = stat ? isDue(stat) : false;
  // 只在「這句練得到、而且使用者確實有問題」時才顯示 ——
  // 每句都掛一個標籤的話，這個標籤就不帶任何資訊了
  const focused = weightedEnabled() ? matchedWeakIssues(current, weak) : [];

  return h('div', { class: 'card' },
    h('div', { class: 'card__meta' },
      h('span', { class: 'chip' }, categoryLabel(current.category)),
      h('span', { class: 'chip chip--muted' }, difficultyLabel(current.difficulty)),
      stat && h('span', {
        class: 'chip chip--past' + (due && since ? ' chip--due' : ''),
      }, pastChipText(stat, since, due)),
      focused.length > 0 && h('span', { class: 'chip chip--focus' },
        `這句在練 ${focused.slice(0, 2).map(issueLabel).join('、')}`),
    ),

    h('p', { class: 'sentence', id: 'sentence' }, current.text),
    // 知道自己在說什麼，練起來才不是在唸音節。早期手寫的句子沒有中文，就不顯示
    current.zh && h('p', { class: 'sentence__zh' }, current.zh),

    h('div', { class: 'row' },
      ttsSupported() && h('button', { class: 'btn btn--ghost', onclick: playDemo }, '🔊 播放正確發音'),
      h('button', {
        class: 'btn btn--ghost',
        disabled: Boolean(recorder?.isRecording),
        onclick: nextSentence,
      }, '🔀 換一句'),
      setRecords.length > 0 &&
        h('span', { class: 'hint' }, `這一組：${setRecords.length} / ${SET_SIZE} 句`),
    ),

    h('label', { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: weightedEnabled(),
        disabled: Boolean(recorder?.isRecording),
        onchange: (e) => {
          updateSettings({ shadowingWeighted: e.target.checked });
          render();
        },
      }),
      h('span', {}, '優先練分數低、久沒練的句子'),
    ),

    outOfPoolNote && h('p', { class: 'hint' }, outOfPoolNote),
  );
}

/**
 * 句子旁邊說明這句以前練得怎麼樣、上次是什麼時候。
 *
 * 這是加權抽句唯一看得見的地方 —— 沒有它的話，「為什麼又是這句」
 * 只會像是隨機抽壞了，而不是「因為你這句只有 42 分，而且上星期就沒再碰過」。
 */
function pastChipText(stat, since, due) {
  const parts = [
    stat.count === 1 ? '練過 1 次' : `練過 ${stat.count} 次`,
    stat.count === 1 ? `${stat.last} 分` : `平均 ${stat.average} 分`,
  ];
  if (since) parts.push(since);
  if (due && since) parts.push('該複習了');
  return parts.join('・');
}

function recordCard() {
  const unsupported = !recSupported() ? unsupportedReason() : '';
  if (unsupported) return h('div', { class: 'banner banner--error' }, unsupported);

  const card = h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '錄下你的發音'),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn--primary', id: 'btn-record', onclick: toggleRecord },
        h('span', { class: 'dot' }), h('span', { id: 'btn-record-label' }, '開始錄音')),
      h('span', { class: 'timer', id: 'timer', hidden: true }, '00:00'),
      h('span', { class: 'level', id: 'level', hidden: true },
        h('span', { class: 'level__bar' }, h('span', { class: 'level__fill', id: 'level-fill' })),
        h('span', { class: 'level__text', id: 'level-text' }, '音量')),
    ),
    // 錄音時的即時波形：讓人在當下就知道麥克風有沒有在收音，
    // 而不是錄完送出後才被「沒有偵測到人聲」擋下來
    h('canvas', { class: 'waveform', id: 'waveform', height: '72', hidden: true,
                  'aria-label': '錄音波形', role: 'img' }),
    h('div', { class: 'status', id: 'status', role: 'status', 'aria-live': 'polite' }),
  );

  if (wavBlob || playbackUrl) {
    const playback = h('div', { class: 'playback' },
      h('p', { class: 'playback__label' }, '你的錄音：'),
      h('audio', { id: 'audio', controls: 'controls', src: playbackUrl }),
      h('p', { class: 'hint', id: 'audio-info' }),
    );
    if (wavBlob && !wavStats?.silent) {
      append(playback,
        h('button', { class: 'btn btn--primary', id: 'btn-submit', onclick: submit },
          '🎯 檢查我的發音'),
        h('p', { class: 'hint' },
          '發音評估需要伺服器設定 Azure（客觀的逐音素分數）或 Gemini（主觀分數）。' +
          '單純想練的話，聽示範 → 錄音 → 自己比對就很有幫助了。'),
      );
    }
    append(card, playback);
  }
  return card;
}

function setStatus(text, kind = '') {
  const el = root?.querySelector('#status');
  if (!el) return;
  el.textContent = text;
  el.className = 'status' + (kind ? ` status--${kind}` : '');
}

// ─── 示範發音 ────────────────────────────────────────────────────────────

async function playDemo(e) {
  const btn = e.currentTarget;   // 非同步 callback 裡 currentTarget 會變 null，先抓下來
  btn.disabled = true;
  try {
    await speak(current.text);
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ─── 錄音 ────────────────────────────────────────────────────────────────

async function toggleRecord() {
  if (recorder?.isRecording) return stopRecording();

  lastResult = null;
  wavBlob = null;
  wavStats = null;
  revokePlayback();

  recorder = new Recorder({
    onTick: (sec) => {
      const t = root?.querySelector('#timer');
      if (t) {
        t.textContent =
          `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
      }
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
  startWaveform();
  setStatus(`錄音中，唸完後按「停止錄音」。（最長 ${MAX_RECORDING_MS / 1000} 秒）`);
}

function startWaveform() {
  const canvas = root?.querySelector('#waveform');
  const stream = recorder?.stream;
  if (!canvas || !stream) return;

  // render() 每次都重建整個模式的 DOM，所以上一個 waveform 抓著的 canvas
  // 已經從文件裡拿掉了 —— 沿用的話波形會畫在一個看不見的元素上。
  if (waveformCanvas !== canvas) {
    waveform?.stop();
    waveform = createWaveform(canvas, showLevel);
    waveformCanvas = canvas;
  }
  // 畫不出來也不影響錄音，所以失敗就算了
  try { waveform.start(stream); } catch (err) { console.warn('[waveform]', err); }
}

/** 即時音量指示（由 waveform 每一幀呼叫）。 */
function showLevel(peak) {
  const fill = root?.querySelector('#level-fill');
  const text = root?.querySelector('#level-text');
  if (!fill || !text) return;
  fill.style.width = `${Math.min(100, Math.round(peak * 140))}%`;
  fill.classList.toggle('level__fill--low', peak < 0.02);
  text.textContent = peak < 0.02 ? '幾乎沒收到聲音' : '收音中';
}

async function stopRecording() {
  if (!recorder?.isRecording) return;
  setStatus('正在把錄音轉成 WAV…', 'busy');
  // 先停波形再關 stream —— 反過來的話 AnalyserNode 會讀到已經結束的 track
  waveform?.stop();

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
  wavStats = result.stats ?? null;
  playbackUrl = URL.createObjectURL(result.wav);
  setRecordingUI(false);
  render();

  const kb = (result.wav.size / 1024).toFixed(1);
  const info = root?.querySelector('#audio-info');
  if (info) {
    info.textContent =
      `WAV ${kb} KB・${result.durationSec.toFixed(2)} 秒・${result.sampleRate} Hz 單聲道` +
      `（原始 ${result.recordedType}）`;
  }

  // 沒有人聲就別讓它送出去。後端也會擋，這裡擋是為了立刻給回饋、順便省一次上傳。
  if (wavStats?.silent) {
    setStatus(
      '這段錄音裡幾乎沒有聲音，送出去也分析不了。\n' +
      '請確認麥克風沒有被靜音、系統選到的輸入裝置是對的，然後靠近一點重錄。',
      'error');
  } else if (wavStats?.quiet) {
    setStatus('錄好了，不過音量偏小，可以再靠近麥克風一點。要送出也沒問題。');
  } else {
    setStatus('錄好了！先聽聽看自己跟示範差在哪。');
  }
}

function setRecordingUI(isRecording) {
  const q = (sel) => root?.querySelector(sel);
  q('#btn-record')?.classList.toggle('is-recording', isRecording);
  const label = q('#btn-record-label');
  if (label) label.textContent = isRecording ? '停止錄音' : '開始錄音';
  for (const sel of ['#timer', '#level', '#waveform']) {
    const el = q(sel);
    if (el) el.hidden = !isRecording;
  }
  // 錄音中要停用所有會換掉目標句的控制項 —— 換掉之後錄好的音就對不上句子了。
  // 這些元素的 disabled 是在 render() 時算的，而 setRecordingUI() 刻意不重畫
  // （重畫會把正在播的 audio 與波形 canvas 都換掉），所以這裡直接改 DOM。
  for (const btn of root?.querySelectorAll('.history__replay') ?? []) {
    btn.disabled = isRecording;
  }
  for (const btn of root?.querySelectorAll('button') ?? []) {
    if (btn.textContent?.includes('換一句')) btn.disabled = isRecording;
  }
  const weightedToggle = root?.querySelector('.check input');
  if (weightedToggle) weightedToggle.disabled = isRecording;
  const goalSelect = root?.querySelector('.today__goal select');
  if (goalSelect) goalSelect.disabled = isRecording;
}

// ─── 送出評估 ────────────────────────────────────────────────────────────

async function submit() {
  if (!wavBlob || !current) return;
  const btn = root?.querySelector('#btn-submit');
  if (btn) btn.disabled = true;
  setStatus(
    getSettings().geminiNarration === false
      ? '分析中（中文講評已關閉，會快一些）…'
      : '分析中，請稍候…',
    'busy'
  );

  const form = new FormData();
  form.append('audio', wavBlob, 'recording.wav');
  form.append('sentence', current.text);
  // 使用者在「設定」選的 model。沒選就不送，後端用它自己的預設值。
  const chosenModel = getSettings().geminiModel;
  if (chosenModel) form.append('model', chosenModel);
  // 關掉中文講評時明講，後端就不會去呼叫 Gemini（分數照樣有）。
  // 只在關掉時送這個欄位 —— 後端沒收到就是預設的「要」。
  if (getSettings().geminiNarration === false) form.append('narrate', 'off');

  try {
    const res = await fetch('/api/pronunciation-feedback', { method: 'POST', body: form });
    const payload = await res.json().catch(() => null);

    if (!res.ok) {
      setStatus(payload?.message ?? `伺服器回了 HTTP ${res.status}，請稍後再試一次。`, 'error');
      return;
    }

    lastResult = payload;

    // 後端判定沒有人聲時不算一次練習，不要拿 0 分去汙染平均分數
    if (payload?.speech_detected === false) {
      render();
      setStatus('');
      return;
    }

    saveAttempt(payload);
    // 六個模式共用的每日計數表。跟讀的逐筆紀錄（history）另外還是要留，
    // 分數與弱點音會回頭決定抽句 —— 這裡記的只是「今天練了幾句」。
    recordPractice('shadowing');
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

/**
 * 把這次的結果寫進紀錄。
 *
 * 關鍵在 `problemWords`：那是弱點加權唯一的來源，而兩個供應商給的形狀不同 ——
 * Azure 給逐音素分數（用 azure-issues.js 翻成分類），Gemini 直接給分類。
 * 統一成同一個形狀之後，弱點統計與一組總結都用同一段程式讀。
 */
function saveAttempt(payload) {
  const score = payload.provider === 'azure'
    ? payload.scores?.pronunciation ?? null
    : payload.score ?? null;

  const problemWords = payload.provider === 'azure'
    ? [problemWordsFromAssessment(payload), prosodyIssue(payload)].flat().filter(Boolean)
    : (Array.isArray(payload.problem_words) ? payload.problem_words : []);

  const record = {
    sentenceId: current.id,
    sentenceText: current.text,
    category: current.category,
    difficulty: current.difficulty,
    score,
    provider: payload.provider ?? 'unknown',
    transcript: payload.recognizedText ?? payload.transcript ?? '',
    problemWords,
  };

  history = addAttempt(record);
  stats = sentenceStats(history);
  weak = weakIssues(history);

  if (typeof score !== 'number') return;
  setRecords.push({ ...record, at: history[0]?.at });

  if (setRecords.length >= SET_SIZE) {
    // 總結畫出來之後就把計數歸零：使用者沒按「再練一組」也照樣可以繼續練，
    // 那些句子要算進下一組，不然第 6 句一送出又會再彈一次總結。
    lastSetSummary = summariseSet(setRecords);
    setRecords = [];
  }
}

function onClearHistory() {
  if (history.length === 0) return;
  if (!window.confirm(`確定要刪掉全部 ${history.length} 筆練習紀錄嗎？這個動作無法復原。`)) {
    return;
  }
  clearHistory();
  history = [];
  stats = new Map();
  weak = new Map();
  setRecords = [];
  lastSetSummary = null;
  render();
}
