import { h, clear, append } from '../lib/dom.js';
import { categoryLabel, difficultyLabel } from '../lib/labels.js';
import { speak, stop as stopTts, isSupported as ttsSupported } from '../lib/tts.js';
import { filterBySettings } from '../lib/settings.js';
import { recordPractice, renderDailyCard } from '../lib/daily.js';
import { grade, diffView, RESULT_HEAD } from '../lib/grade.js';
import { Recorder, isSupported as recSupported, describeMicError, MAX_RECORDING_MS } from '../lib/recorder.js';

export const meta = { id: 'dialogue', label: '情境對話', icon: '💬' };


let all = [];
let current = null;
let step = 0;            // 目前進行到第幾個 turn
let checked = null;      // 這一輪的作答結果
let revealed = false;    // 有沒有先看參考說法
let scores = [];         // 每個「你的台詞」的判定結果
let recorder = null;
let recState = 'idle';   // idle | recording | done
let playbackUrl = null;
let root = null;

export async function mount(container) {
  root = container;
  const res = await fetch('/api/content/dialogues');
  if (!res.ok) throw new Error(`讀取情境對話失敗（HTTP ${res.status}）`);
  const raw = await res.json();
  all = filterBySettings(raw);
  if (all.length === 0) all = raw;
  start(all[Math.floor(Math.random() * all.length)]);
  return cleanup;
}

function cleanup() {
  stopTts();
  recorder?.cleanup();
  recorder = null;
  revokePlayback();
  root = null;
}

function revokePlayback() {
  if (playbackUrl) { URL.revokeObjectURL(playbackUrl); playbackUrl = null; }
}

function start(dialogue) {
  stopTts();
  current = dialogue;
  step = 0;
  checked = null;
  revealed = false;
  scores = [];
  resetRecording();
  render();
  // 如果第一句是對方講的，直接唸出來
  maybeSpeakPartner();
}

function resetRecording() {
  recorder?.cleanup();
  recorder = null;
  recState = 'idle';
  revokePlayback();
}

function currentTurn() {
  return current?.turns[step] ?? null;
}

function isFinished() {
  return step >= (current?.turns.length ?? 0);
}

async function maybeSpeakPartner() {
  const turn = currentTurn();
  if (!turn || turn.speaker !== 'partner' || !ttsSupported()) return;
  try {
    await speak(turn.en);
  } catch (err) {
    console.error('[tts]', err);
  }
}

function advance() {
  // 只有「自己說完一句」才算今天的進度 —— 對方的台詞是語音在唸，
  // 一路按「換我說」不該累積出練習量
  if (currentTurn()?.speaker === 'you') recordPractice('dialogue');
  step++;
  checked = null;
  revealed = false;
  resetRecording();
  render();
  maybeSpeakPartner();
}

// ─── 畫面 ────────────────────────────────────────────────────────────────
function render() {
  if (!root || !current) return;
  clear(root);

  append(root, renderDailyCard('dialogue'));
  append(root, headerCard());
  append(root, transcriptCard());

  if (isFinished()) {
    append(root, summaryCard());
  } else if (currentTurn().speaker === 'partner') {
    append(root, partnerCard());
  } else {
    append(root, yourTurnCard());
    if (checked) append(root, resultCard());
  }
}

function headerCard() {
  const userTurns = current.turns.filter((t) => t.speaker === 'you').length;
  return h('div', { class: 'card' },
    h('div', { class: 'card__meta' },
      h('span', { class: 'chip' }, categoryLabel(current.category)),
      h('span', { class: 'chip chip--muted' }, difficultyLabel(current.difficulty)),
      h('span', { class: 'counter' }, `${Math.min(scores.length, userTurns)} / ${userTurns} 句`),
    ),
    h('h2', { class: 'listen__title' }, current.title),
    h('p', { class: 'dlg__setting' }, current.setting_zh),
    h('p', { class: 'hint' },
      `你扮演「${current.your_role_zh}」，對方是「${current.partner_role_zh}」。`),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn--ghost', onclick: () => start(current) }, '↻ 重來這段'),
      h('button', { class: 'btn btn--ghost', onclick: nextDialogue }, '🔀 換一段情境'),
    ),
  );
}

/** 已經進行過的對話，像聊天記錄一樣往下長 */
function transcriptCard() {
  const card = h('div', { class: 'card dlg' });
  const shown = current.turns.slice(0, step);

  if (shown.length === 0) {
    append(card, h('p', { class: 'hint' }, '對話還沒開始。'));
    return card;
  }

  shown.forEach((turn, i) => {
    if (turn.speaker === 'partner') {
      append(card, 
        h('div', { class: 'bubble bubble--them' },
          h('span', { class: 'bubble__who' }, current.partner_role_zh),
          h('p', { class: 'bubble__text' }, turn.en),
          ttsSupported() && h('button', {
            class: 'bubble__play',
            title: '再聽一次',
            onclick: (e) => replay(turn.en, e.currentTarget),
          }, '🔊'),
        ),
      );
    } else {
      const said = scores[countUserTurnsBefore(i)];
      append(card, 
        h('div', { class: 'bubble bubble--you' },
          h('span', { class: 'bubble__who' }, current.your_role_zh),
          h('p', { class: 'bubble__text' }, said?.input?.trim() || turn.answer),
          said && said.level !== 'exact' && said.level !== 'close'
            ? h('p', { class: 'bubble__ref' }, `參考：${turn.answer}`)
            : null,
        ),
      );
    }
  });
  return card;
}

function countUserTurnsBefore(index) {
  return current.turns.slice(0, index).filter((t) => t.speaker === 'you').length;
}

function partnerCard() {
  const turn = currentTurn();
  return h('div', { class: 'card' },
    h('p', { class: 'card__title' }, `${current.partner_role_zh}說`),
    h('p', { class: 'dlg__line' }, turn.en),
    h('div', { class: 'row' },
      ttsSupported() && h('button', {
        class: 'btn btn--ghost',
        onclick: (e) => replay(turn.en, e.currentTarget),
      }, '🔊 再聽一次'),
      h('button', { class: 'btn btn--primary', onclick: advance }, '換我說 →'),
    ),
  );
}

function yourTurnCard() {
  const turn = currentTurn();

  const card = h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '換你說'),
    h('p', { class: 'dlg__intent' }, turn.intent_zh),
    h('textarea', {
      class: 'trans__input', id: 'answer', rows: '2',
      placeholder: '用英文說出這個意思…',
      spellcheck: 'false',
      disabled: Boolean(checked),
      onkeydown: (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); check(); }
      },
    }, checked?.input ?? ''),
  );

  if (!checked) {
    append(card, 
      h('div', { class: 'row' },
        h('button', { class: 'btn btn--primary', onclick: check }, '對答案'),
        !revealed && h('button', {
          class: 'btn btn--link',
          onclick: () => { revealed = true; render(); },
        }, '想不出來，看參考說法'),
      ),
      revealed && h('p', { class: 'trans__hint' }, `參考說法：${turn.answer}`),
      h('p', { class: 'hint' }, '按 Ctrl/⌘ + Enter 送出。'),
    );
  }
  return card;
}

/** 選用：把這句話唸出來練發音 */
function recordingRow(line) {
  const row = h('div', { class: 'dlg__record' },
    h('p', { class: 'hint' }, `想順便練發音的話，把這句唸出來：「${line}」`),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn' + (recState === 'recording' ? ' is-recording' : ''),
        onclick: toggleRecord,
      },
        h('span', { class: 'dot' }),
        recState === 'recording' ? '停止錄音' : '🎙 錄下這句'),
      recState === 'done' && playbackUrl
        ? h('audio', { controls: 'controls', src: playbackUrl })
        : null,
    ),
    h('div', { class: 'status', id: 'rec-status' }),
  );
  return row;
}

function resultCard() {
  const turn = currentTurn();
  const { level, missing } = checked.result;
  const [title, tone] = RESULT_HEAD[level];

  const card = h('div', { class: `card result--${tone}` },
    h('p', { class: 'result__title' }, title),
  );

  if (level === 'close') {
    append(card, h('p', { class: 'hint' }, '關鍵用字都有，說法跟參考答案不同沒關係。'));
  }
  if (level === 'wrong' && missing?.length) {
    append(card, h('p', { class: 'hint' }, `少了這些關鍵用字：${missing.join('、')}`));
  }

  // 完全相符時再秀一次一模一樣的對照只是雜訊
  if (level !== 'exact') {
    append(card, diffView(checked.input || '（空白）', turn.answer));
  }

  if (turn.accept.length > 1) {
    append(card, h('p', { class: 'hint' }, `另一種說法：${turn.accept[1]}`));
  }
  append(card, h('p', { class: 'explain explain--neutral' }, turn.note_zh));

  // 知道正確說法之後再練發音才有意義，所以錄音放在這裡而不是作答前
  if (recSupported()) append(card, recordingRow(turn.answer));

  append(card, 
    h('div', { class: 'row' },
      ttsSupported() && h('button', {
        class: 'btn btn--ghost',
        onclick: (e) => replay(turn.answer, e.currentTarget),
      }, '🔊 唸一次參考說法'),
      h('button', { class: 'btn', onclick: () => { checked = null; render(); } }, '再試一次'),
      h('button', { class: 'btn btn--primary', onclick: advance },
        step === current.turns.length - 1 ? '完成對話 →' : '繼續對話 →'),
    ),
  );
  return card;
}

function summaryCard() {
  const total = scores.length;
  const good = scores.filter((s) => s.level === 'exact' || s.level === 'close').length;

  return h('div', { class: 'card' },
    h('p', { class: 'result__title' }, '對話完成 🎉'),
    h('p', { class: 'result__score' }, `${total} 句裡有 ${good} 句表達到位`),
    h('p', { class: 'hint' },
      good === total
        ? '整段對話都接得上，很好！換一段更難的試試。'
        : '上面的對話記錄裡，沒過關的句子會附上參考說法，可以往回看。'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => start(current) }, '再練一次這段'),
      h('button', { class: 'btn btn--primary', onclick: nextDialogue }, '換一段情境'),
    ),
  );
}

// ─── 動作 ────────────────────────────────────────────────────────────────
async function replay(text, button) {
  const original = button.textContent;
  button.disabled = true;
  try {
    await speak(text);
  } catch (err) {
    console.error('[tts]', err);
    button.textContent = '⚠️';
    setTimeout(() => { button.textContent = original; }, 1500);
  } finally {
    button.disabled = false;
  }
}

function check() {
  const el = root?.querySelector('#answer');
  const input = el?.value ?? '';
  const turn = currentTurn();
  const result = grade(turn, input);

  checked = { input, result };
  // 記錄這一輪的結果（再試一次會覆蓋掉同一格）
  scores[countUserTurnsBefore(step)] = { input, level: result.level };
  render();
}

function nextDialogue() {
  let next = current;
  while (all.length > 1 && next.id === current.id) {
    next = all[Math.floor(Math.random() * all.length)];
  }
  start(next);
}

function setRecStatus(text, kind = '') {
  const el = root?.querySelector('#rec-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'status' + (kind ? ` status--${kind}` : '');
}

async function toggleRecord() {
  if (recState === 'recording') {
    try {
      const result = await recorder.stop();
      revokePlayback();
      playbackUrl = URL.createObjectURL(result.wav);
      recState = 'done';
      render();
      setRecStatus(`錄好了：${(result.wav.size / 1024).toFixed(1)} KB・${result.durationSec.toFixed(1)} 秒`);
    } catch (err) {
      console.error('[錄音]', err);
      recState = 'idle';
      render();
      setRecStatus(err.message, 'error');
    }
    return;
  }

  recorder = new Recorder({
    onAutoStop: () => { setRecStatus('已達最長錄音時間，自動停止。'); toggleRecord(); },
  });
  try {
    await recorder.start();
  } catch (err) {
    console.error('[getUserMedia]', err);
    setRecStatus(describeMicError(err), 'error');
    recorder = null;
    return;
  }
  recState = 'recording';
  render();
  setRecStatus(`錄音中…（最長 ${MAX_RECORDING_MS / 1000} 秒）`);
}
