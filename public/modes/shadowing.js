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
import { bindKeys } from '../lib/keys.js';
import { filterBySettings, getSettings, updateSettings, aiMode, setAiMode, AI_MODES } from '../lib/settings.js';
import { speak, isSupported as ttsSupported } from '../lib/tts.js';
import {
  Recorder, isSupported as recSupported, unsupportedReason,
  describeMicError, MAX_RECORDING_MS,
} from '../lib/recorder.js';
import { addAttempt, getHistory, clearHistory } from '../lib/storage.js';
import { createWaveform } from '../lib/waveform.js';
import { categoryLabel, difficultyLabel, issueLabel, relativeTime } from '../lib/labels.js';
import {
  sentenceStats, pickSentence, isDue, practisedOn, weakIssues, matchedWeakIssues,
  summariseSet, nextSentenceAction, SET_SIZE,
} from '../lib/practice.js';
import { problemWordsFromAssessment, prosodyIssue } from '../lib/azure-issues.js';
import { renderAssessment } from './assessment-view.js';
import { requestNarration, quotaNote } from '../lib/ai-review.js';
import { chipField } from '../lib/fields.js';
import { renderToday, renderSetSummary, renderHistory } from './shadowing-views.js';
import { recordPractice } from '../lib/daily.js';
import { demoSource, referencePitch } from '../lib/reference-pitch.js';
import { goalOf, setGoal } from '../lib/settings.js';

export const meta = { id: 'shadowing', label: '跟讀', icon: '🗣️' };

const DEFAULT_GOAL = SET_SIZE;

/**
 * 按下「播放正確發音」之後，最多等多久範例音訊。
 *
 * 1.2 秒是「還在按鍵的反應時間裡」的上限。等不到就先用瀏覽器的 TTS 出聲 ——
 * 乾等三秒才聽到聲音，比聽到一個不同的聲音更糟。
 */
const REFERENCE_WAIT_MS = 1200;

let allSentences = [];   // 句庫全部（「重練這句」要能跨過篩選條件）
let pool = [];           // 目前篩選條件內的句子
let current = null;
let recorder = null;
let waveform = null;
let waveformCanvas = null;   // render() 會重建 DOM，波形要跟著換到新的 canvas
let wavBlob = null;
let wavStats = null;
let wavPitch = null;   // 這段錄音的語調曲線（blobToWav() 順手算好的）
let refPitch = null;   // 這一句的**範例**曲線（伺服器合成的，見 lib/reference-pitch.js）
let playbackUrl = null;
let lastResult = null;
let history = [];
let stats = new Map();   // 依句子彙整的成績；history 一變就重算
let weak = new Map();    // 最近哪些音出問題出得最多
let setRecords = [];     // 這一組練到第幾句（只存在記憶體：一組是「這次坐下來練的」）
let pendingSummary = null;  // 這一組的總結，還沒給使用者看
let showingSummary = false; // 現在停在總結那一頁（擋在「換一句」前面，見 onNextSentence）
// 手動要來的中文講評：null（還沒要）| { phase: 'loading'|'done'|'error', … }。
// 跟著 lastResult 走 —— 換一句、或重新送出一次錄音都要清掉
let narration = null;
let outOfPoolNote = '';
let root = null;
let unbindKeys = null;

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
  unbindKeys = bindKeys(onKey);
  return cleanup;
}

/**
 * 空白鍵開始／停止錄音、`P` 播放範例、`N` 換一句。
 *
 * 空白鍵是這裡最有感的一個 —— 錄音是「開始說話前一刻按下、說完馬上按停」，
 * 中間還要移動滑鼠去點按鈕的話，前後都會多錄到一段空白（而空白會拉低流暢度分數）。
 *
 * **錄音中只有空白鍵有事做**：`N` 換一句會讓錄好的音對不上句子，所以跟畫面上
 * 那顆被停用的按鈕一樣，錄音中直接不接。
 */
function onKey(key) {
  if (!root || !current) return false;

  // 停在總結那一頁時畫面上只有一顆「再練一組」。**空白鍵尤其要攔**：
  // 那一頁沒有錄音的按鈕，照原本的規則按下去會在背後開始錄音
  if (showingSummary) {
    if (key === 'enter' || key === 'space' || key === 'n') { dismissSummary(); return true; }
    return false;
  }

  const recording = Boolean(recorder?.isRecording);

  if (key === 'space') { toggleRecord(); return true; }
  if (recording) return false;
  if (key === 'p') { playDemo(); return true; }
  if (key === 'n') { onNextSentence(); return true; }
  // 錄好了就送出 —— Enter 在每個模式都是「這個畫面的主要動作」
  if (key === 'enter') {
    const btn = root.querySelector('#btn-submit');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }
  // 手動模式下要一次中文講評（自動模式下那顆按鈕根本不存在）
  if (key === 'a') {
    const btn = root.querySelector('.airev button');
    if (!btn) return false;
    btn.click();
    return true;
  }
  return false;
}

function cleanup() {
  window.removeEventListener('settings-changed', onSettingsChanged);
  unbindKeys?.();
  unbindKeys = null;
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

/**
 * 使用者按「換一句」（或按 N）。
 *
 * **一組練完的總結擋在這裡。** 原本它是畫在講評下面的第四張卡，而那個位置
 * 在手機上要再捲兩三個螢幕才看得到 —— 實際用起來就是一路按「換一句」，
 * 那張總結一次也沒被看到過。現在按下去先停在總結，那一頁自己有「再練一組」接回去，
 * 所以只多一次點擊，而且是在使用者本來就要按的那顆按鈕上。
 *
 * 不自動彈出來、也不插在講評上面：剛錄完最想看的是自己這一句幾分，
 * 總結是「這一組」的結論，等他要往下走的那一刻才是它的位置。
 */
function onNextSentence() {
  // 三種情況（規則與理由在 `nextSentenceAction()`，那裡測得到）：
  // 已經在總結那一頁 → 當成「再練一組」，不然總結沒被清掉，
  // 下一句的按鈕又會變回「看總結」，永遠出不去
  switch (nextSentenceAction({ pendingSummary, showingSummary })) {
    case 'dismiss':
      return dismissSummary();
    case 'summary':
      showingSummary = true;
      render();
      root?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    default:
      return nextSentence();
  }
}

/** 看完總結，開下一組。 */
function dismissSummary() {
  pendingSummary = null;
  showingSummary = false;
  nextSentence();
}

function nextSentence() {
  showingSummary = false;
  narration = null;
  refPitch = null;
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
  refPitch = null;
  // 他自己挑了一句要練，就別再停在總結那一頁 ——
  // 總結本身留著，「換一句」那顆按鈕還是進得去
  showingSummary = false;

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
  wavPitch = null;
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

  // 一組練完的總結**自己占一頁**（側欄的今天與紀錄照舊留著）。
  // 跟單字卡的「選難度 / 複習盒」是同一個做法：要使用者停下來看的東西，
  // 就不要跟他正在做的事擠在同一欄
  if (showingSummary && pendingSummary) {
    append(main, renderSetSummary(pendingSummary, dismissSummary));
    append(side, renderHistory(history, {
      sentences: allSentences,
      onReplay: practiseSentence,
      onClear: onClearHistory,
      replayDisabled: false,
    }));
    return;
  }

  append(main, sentenceCard(), recordCard());

  if (lastResult) {
    const card = h('div', { class: 'card' }, h('p', { class: 'card__title' }, '發音講評'));
    renderAssessment(card, lastResult, current.text, (el) => {
      const target = root.querySelector('#sentence');
      if (target) target.replaceWith(el);
    }, {
      narration: narrationBox(),
      pitch: wavPitch,
      // 要到的那一句必須就是現在這一句 —— 換過句子之後舊的曲線疊上去，
      // 圖會看起來像「你這句唸得完全不對」
      reference: refPitch?.id === current.id ? refPitch : null,
    });
    append(main, card);
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
      // 總結還沒看的時候，這顆按鈕就是去看總結的入口 ——
      // 使用者本來就會按這裡，而總結原本躲在整頁的最下面
      h('button', {
        class: pendingSummary ? 'btn btn--primary' : 'btn btn--ghost',
        disabled: Boolean(recorder?.isRecording),
        onclick: onNextSentence,
      }, pendingSummary ? `✅ 這一組 ${SET_SIZE} 句練完了，看總結` : '🔀 換一句'),
      setRecords.length > 0 &&
        h('span', { class: 'hint' }, `這一組：${setRecords.length} / ${SET_SIZE} 句`),
    ),

    // 抽句方式。**跟設定頁裡的那一個是同一個選項、也長同一個樣子**
    // （`lib/fields.js`）—— 一個 checkbox 一排 chip 的話，
    // 使用者會以為是兩件不同的事，而 checkbox 還會讓人去找「儲存」按鈕
    chipField('抽句方式',
      [[true, '優先練弱點'], [false, '完全隨機']],
      weightedEnabled(),
      (value) => {
        if (recorder?.isRecording) return;   // 錄音中不要換抽句規則
        updateSettings({ shadowingWeighted: value });
        render();
      },
      {
        hint: weightedEnabled()
          ? '分數低的、久沒練的、以及練得到你常錯的音的句子會比較常出現。'
          : '每一句機率一樣。覺得「怎麼一直抽到同幾句」的時候用這個。',
      }),

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
    // 這一句的成績講的是**紀錄分數（最高的那一次）**，因為抽句看的也是它 ——
    // 這裡寫平均、那裡照最高算的話，「為什麼又是這句」就對不起來了
    stat.count === 1 ? `${stat.best} 分` : `最高 ${stat.best} 分`,
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
          '發音評分要先在設定頁填 Azure 或 Gemini 金鑰。沒有也能聽示範 → 錄音 → 自己比對。'),
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

/**
 * 播放示範發音。
 *
 * **能放 Azure 那一份就放它** —— 圖上畫的是它的語調，耳朵聽到的卻是瀏覽器內建的
 * 聲音的話，兩個人的語調本來就不同，使用者會以為圖畫錯了。
 * 哪一個由 `demoSource()` 決定（純函式，那裡測得到）。
 *
 * 第一次按的時候通常還沒有（要等合成），所以**等一下下再決定**：
 * `REFERENCE_WAIT_MS` 內拿到就放 Azure 的，沒拿到就先用 TTS 頂著，
 * 下一次按就會是 Azure 的了。與其讓人乾等，不如先出聲。
 *
 * @param {Event|null} e 鍵盤按 P 的時候沒有按鈕可以停用，所以可以不給
 */
async function playDemo(e = null) {
  const btn = e?.currentTarget ?? null;   // 非同步 callback 裡 currentTarget 會變 null，先抓下來
  if (btn) btn.disabled = true;
  const id = current.id;

  try {
    await Promise.race([wantReference(), delay(REFERENCE_WAIT_MS)]);
    if (current?.id !== id) return;       // 等的時候換句子了

    const source = demoSource(refPitch, id);
    if (source.kind === 'audio') {
      await playAudio(source.url);
      return;
    }
    await speak(current.text);
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 放一個網址上的音檔。播不出來就丟例外，讓呼叫端退回 TTS。 */
function playAudio(url) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    audio.addEventListener('ended', () => resolve(), { once: true });
    audio.addEventListener('error', () => reject(new Error('範例音訊播不出來')), { once: true });
    audio.play().catch(reject);
  });
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 去要這一句的範例曲線（要到了就留著，等講評出來時疊到圖上）。
 *
 * **時機是「使用者已經決定要練這一句」** —— 按了播放示範、或按了錄音 ——
 * 而不是換到這一句就要：第一次要一句會讓伺服器呼叫一次 Azure 合成（花錢），
 * 而「換一句」是這個模式裡按得最兇的按鈕。
 *
 * 不 await：曲線要不要得到都不影響錄音，而錄音那三秒剛好把延遲藏起來。
 * 要到了才重畫，而且**要確認使用者還停在同一句**（要的過程中他可能已經換過了）。
 */
function wantReference() {
  const id = current?.id;
  if (id === undefined || refPitch?.id === id) return Promise.resolve();

  return referencePitch(id).then((data) => {
    if (!data || current?.id !== id) return;
    refPitch = { id, ...data };
    // 分數還沒回來時圖還沒畫，重畫一次不會有任何視覺變化；
    // 已經畫好了的話這一次就會補上那條淡色的線
    if (lastResult) render();
  });
}

// ─── 錄音 ────────────────────────────────────────────────────────────────

async function toggleRecord() {
  if (recorder?.isRecording) return stopRecording();

  wantReference();
  lastResult = null;
  wavBlob = null;
  wavStats = null;
  wavPitch = null;
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
  wavPitch = result.pitch ?? null;
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

/**
 * 「手動要中文講評」那一段。
 *
 * 為什麼要有手動這條路：講評原本是「送出錄音時一起要」，也就是全有或全無 ——
 * 想省那幾秒就得整個關掉，然後遇到真的想知道的那一句時沒有辦法補要。
 * 三個 AI 功能現在都是自動／手動／關（見 `lib/settings.js` 的 `AI_FEATURES`），
 * 而這裡是跟讀那一個的手動路徑。
 *
 * 補要的是**已經算好的分數**，不是重送錄音 —— 重送等於再花一次 Azure 的錢。
 *
 * @returns {{text?: string, label?: string, ms?: number, view?: HTMLElement}|null}
 */
function narrationBox() {
  // 自動模式、或這一趟本來就拿到講評了，就沒有什麼要按的
  const mode = aiMode('narration');
  if (mode !== 'manual') return null;
  if (lastResult?.narrationSource && lastResult.narrationSource !== 'local') return null;
  // 沒有人聲那一種回應連分數都沒有，補要講評沒有意義
  if (lastResult?.speech_detected === false) return null;

  if (narration?.phase === 'done') {
    return { text: narration.text, label: narration.label, ms: narration.ms, view: quotaLine(narration) };
  }

  const view = h('div', { class: 'airev' });
  if (narration?.phase === 'loading') {
    append(view, h('p', { class: 'status status--busy' }, '🤖 正在寫中文講評…'));
    return { view };
  }
  if (narration?.phase === 'error') {
    append(view,
      h('p', { class: 'hint hint--warn' }, `🤖 ${narration.message}`),
      // 沒設定模型、或今天的次數用完了都不給重試 —— 按幾次都是同一個結果
      !['no_key', 'quota'].includes(narration.reason)
        && h('button', { class: 'btn btn--ghost', onclick: askNarration }, '🤖 再要一次'),
    );
    return { view };
  }

  append(view,
    h('button', { class: 'btn btn--ghost', onclick: askNarration }, '🤖 要中文講評'),
    h('p', { class: 'hint' }, '按 A 也可以。分數已經算好了，不會重送錄音。'),
  );
  return { view };
}

function quotaLine(state) {
  const note = quotaNote(state.quota);
  return note ? h('p', { class: 'hint' }, note) : null;
}

/** 手動要一次講評。**不重送錄音** —— 送的是畫面上已經有的那份評估結果。 */
function askNarration() {
  if (!lastResult || narration?.phase === 'loading') return;
  narration = { phase: 'loading' };
  render();

  const model = getSettings().geminiModel || undefined;
  requestNarration(lastResult, { model }).then((out) => {
    // 換句、或又送了一次錄音的話這一份就過期了
    if (!root || !lastResult) return;
    narration = out.ok
      ? { phase: 'done', text: out.feedback_zh, label: out.label, ms: out.ms, quota: out.quota }
      : { phase: 'error', reason: out.reason, message: out.message, quota: out.quota };
    render();
  });
}

// ─── 送出評估 ────────────────────────────────────────────────────────────

async function submit() {
  if (!wavBlob || !current) return;
  const btn = root?.querySelector('#btn-submit');
  if (btn) btn.disabled = true;
  narration = null;
  setStatus(
    aiMode('narration') === 'auto'
      ? '分析中，請稍候…'
      : '分析中（這一趟不等中文講評，會快一些）…',
    'busy'
  );

  const form = new FormData();
  form.append('audio', wavBlob, 'recording.wav');
  form.append('sentence', current.text);
  // 使用者在「設定」選的 model。沒選就不送，後端用它自己的預設值。
  const chosenModel = getSettings().geminiModel;
  if (chosenModel) form.append('model', chosenModel);
  // 「自動」以外都不在這一趟要講評，後端就不會去呼叫模型（分數照樣有）。
  // 手動模式下的講評是之後按按鈕、走 /api/narration 補要的 ——
  // 那條路送的是算好的分數，不會再花一次 Azure 的錢。
  // 只在不要的時候送這個欄位 —— 後端沒收到就是預設的「要」。
  if (aiMode('narration') !== 'auto') form.append('narrate', 'off');

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

    // **一句算一次。** 今天的數字算的是「練了幾句」，而同一句錄第二次、第三次
    // 是在把它練好，不是多練了兩句 —— 照次數算的話，卡在一句上反覆重錄的那一天
    // 反而是數字最漂亮的一天。要在 `saveAttempt()` **之前**問，
    // 因為那一行就會把這一次寫進 history 裡。
    const firstToday = !practisedOn(history, current.id);

    saveAttempt(payload);
    // 六個模式共用的每日計數表。跟讀的逐筆紀錄（history）另外還是要留，
    // 分數與弱點音會回頭決定抽句 —— 這裡記的只是「今天練了幾句」。
    if (firstToday) recordPractice('shadowing');
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
  addToSet({ ...record, at: history[0]?.at });

  if (setRecords.length >= SET_SIZE) {
    // 算好先放著，等使用者按「換一句」的時候才擋下來給他看（`onNextSentence()`）。
    // 計數立刻歸零：他沒去看總結也照樣可以繼續練，那些句子要算進下一組，
    // 不然第 6 句一送出又會再生一份總結。
    pendingSummary = summariseSet(setRecords);
    setRecords = [];
  }
}

/**
 * 把這一次放進「這一組」。
 *
 * **一組 5 句指的是 5 個句子**，所以同一句重錄不會讓 `3 / 5` 變成 `4 / 5`，
 * 而是**換掉**那一句在這一組裡的成績。換的時候留分數高的那一次
 * （跟 `recordScore()` 同一條規則：重錄是在把一句練好），
 * 不然總結的「最高 / 最低」會被自己失敗的那幾次拉下來。
 */
function addToSet(record) {
  const at = setRecords.findIndex((r) => r.sentenceId === record.sentenceId);
  if (at < 0) {
    setRecords.push(record);
    return;
  }
  if (record.score > setRecords[at].score) setRecords[at] = record;
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
  pendingSummary = null;
  showingSummary = false;
  render();
}
