import { h, append } from '../lib/dom.js';
import { columns } from '../lib/layout.js';
import { bindKeys } from '../lib/keys.js';
import { categoryLabel, difficultyLabel } from '../lib/labels.js';
import { speak, stop as stopTts, isSupported as ttsSupported } from '../lib/tts.js';
import { filterBySettings, getSettings, aiMode } from '../lib/settings.js';
import { recordPractice, renderDailyCard } from '../lib/daily.js';
import { grade, diffView, normalize, RESULT_HEAD } from '../lib/grade.js';
import { createReviewer, reviewKey, storedReview } from '../lib/ai-review.js';
import { answerPair, sentenceRow, moreBox } from '../lib/answer-lines.js';
import { Recorder, isSupported as recSupported, describeMicError, MAX_RECORDING_MS } from '../lib/recorder.js';

export const meta = { id: 'dialogue', label: '情境對話', icon: '💬' };


let all = [];
let current = null;
let step = 0;            // 目前進行到第幾個 turn
let checked = null;      // 這一輪的作答結果
let revealed = false;    // 有沒有先看參考說法
let scores = [];         // 每個「你的台詞」的判定結果
// AI 修正。狀態、快取、那一段畫面都在 lib/ai-review.js（中翻英用的是同一份）
let reviewer = null;
let recorder = null;
let recState = 'idle';   // idle | recording | done
let playbackUrl = null;
let root = null;
let unbindKeys = null;

export async function mount(container) {
  root = container;
  const res = await fetch('/api/content/dialogues');
  if (!res.ok) throw new Error(`讀取情境對話失敗（HTTP ${res.status}）`);
  const raw = await res.json();
  all = filterBySettings(raw);
  if (all.length === 0) all = raw;
  reviewer = createReviewer({ onChange: render });
  start(all[Math.floor(Math.random() * all.length)]);
  unbindKeys = bindKeys(onKey);
  return cleanup;
}

/**
 * `Enter` 往下一步、`P` 再聽一次對方那句。
 *
 * 打字中的 Enter 由輸入框自己處理（⌘+Enter 送出，一般的 Enter 要能換行），
 * 這裡接的是**焦點不在輸入框時**的 Enter —— 對方在說話、或自己已經對完答案。
 */
function onKey(key) {
  if (!root || !current) return false;

  // 換一段情境：整段對話的任何時候都能按（畫面右上角那顆按鈕）
  if (key === 'n') { nextDialogue(); return true; }

  if (key === 'p') {
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('再聽一次'));
    if (!btn) return false;
    btn.click();
    return true;
  }

  // 想不出來就看參考說法（跟中翻英的 H 是同一個意思）
  if (key === 'h' && !checked && !revealed && currentTurn()?.speaker === 'you') {
    revealed = true;
    render();
    return true;
  }

  if (checked) {
    if (key === 's') { root.querySelector('#btn-speak')?.click(); return true; }
    if (key === 'a') { root.querySelector('.airev button')?.click(); return true; }
  }

  if (key !== 'enter') return false;
  if (isFinished()) return false;
  // 對方講完換我說、或者我已經對完答案要繼續 —— 兩種都是 advance()
  if (currentTurn().speaker === 'partner' || checked) { advance(); return true; }
  return false;
}

function cleanup() {
  unbindKeys?.();
  unbindKeys = null;
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
  reviewer?.reset();
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
  reviewer?.reset();
  resetRecording();
  render();
  maybeSpeakPartner();
}

// ─── 畫面 ────────────────────────────────────────────────────────────────
function render() {
  if (!root || !current) return;
  // 主欄是對話本身，右邊放「我是誰、在哪裡」那張說明卡 ——
  // 角色與情境在整段對話裡都成立，卻只在最上面看得到一次
  const { main, side } = columns(root);

  append(side, renderDailyCard('dialogue'), headerCard());
  append(main, transcriptCard());

  if (isFinished()) {
    append(main, summaryCard());
  } else if (currentTurn().speaker === 'partner') {
    append(main, partnerCard());
  } else {
    append(main, yourTurnCard());
    if (checked) append(main, resultCard());
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
      // 存下來的 AI 修正也放回對話記錄裡。存了卻沒有地方看得到的話，
      // 那份資料對使用者不存在 —— 而它是花錢換來的
      const stored = said?.input ? storedReviewFor(i, said.input) : null;
      append(card, 
        h('div', { class: 'bubble bubble--you' },
          h('span', { class: 'bubble__who' }, current.your_role_zh),
          h('p', { class: 'bubble__text' }, said?.input?.trim() || turn.answer),
          said && said.level !== 'exact' && said.level !== 'close'
            ? h('p', { class: 'bubble__ref' }, `參考：${turn.answer}`)
            : null,
          stored?.corrected && normalize(stored.corrected) !== normalize(said.input)
            ? h('p', { class: 'bubble__ref' }, `🤖 更自然：${stored.corrected}`)
            : null,
        ),
      );
    }
  });
  return card;
}

/** 對話記錄裡第 index 句台詞存下來的修正（句子要對得上，理由見 storedReview）。 */
function storedReviewFor(index, input) {
  return storedReview(reviewKey('dialogue', current.id, index), input);
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
    h('p', { class: 'hint' }, `順便練發音：把「${line}」唸出來`),
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

/**
 * 對完一句台詞之後的那張卡。
 *
 * **順序跟中翻英一致**（那邊的說明寫得比較完整）：判定 → 兩句並列
 * （🤖 AI 改的在上、📘 參考說法在下）→ AI 的說明 → 收起來的細節 → 錄音 → 按鈕。
 *
 * 情境對話這邊 AI 那句尤其重要：模型收得到情境、角色、對方剛剛說的話
 * （見 `check()`），所以它給的是「在這個場合這樣講對不對」——
 * 而教材的參考說法只有一種寫法。
 */
function resultCard() {
  const turn = currentTurn();
  const { level, missing } = checked.result;
  const [title, tone] = RESULT_HEAD[level];
  const ai = reviewer.render();

  const card = h('div', { class: `card result--${tone}` },
    h('p', { class: 'result__title' }, title),
    answerPair(
      ai.row,
      sentenceRow('📘 參考說法', turn.answer, { tone: 'ref', speakText: turn.answer }),
    ),
    ai.notes,
  );

  // 少了哪些關鍵用字：直接指出下一步要補什麼，所以不收起來
  if (level === 'wrong' && missing?.length) {
    append(card, h('p', { class: 'hint' }, `少了關鍵用字：${missing.join('、')}`));
  }
  if (turn.accept.length > 1) {
    append(card, h('p', { class: 'hint' }, `也可以說：${turn.accept[1]}`));
  }

  append(card, moreBox('看詳細比對',
    // 完全相符時再秀一次一模一樣的對照只是雜訊
    level !== 'exact' && diffView(checked.input || '（空白）', turn.answer),
    turn.note_zh && h('p', { class: 'explain explain--neutral' }, turn.note_zh),
    ai.credit,
  ));

  // 知道正確說法之後再練發音才有意義，所以錄音放在這裡而不是作答前
  if (recSupported()) append(card, recordingRow(turn.answer));

  append(card, 
    h('div', { class: 'row' },
      ttsSupported() && h('button', {
        class: 'btn btn--ghost', id: 'btn-speak',
        onclick: (e) => replay(turn.answer, e.currentTarget),
      }, '🔊 唸一次參考說法'),
      h('button', { class: 'btn', onclick: () => { checked = null; reviewer.reset(); render(); } }, '再試一次'),
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
  // AI 修正：同一句話已經要過的話直接拿存下來的，**不再付一次錢**。
  // 送出去的東西見 server/coach.js 的 parseReviewRequest()：情境、角色、
  // 對方剛剛說的話都要帶上，少了它們模型只能就句子論句子，
  // 而同一句話在咖啡店與在藥局是完全不同的評語。
  //
  // 本地批改先畫出來（免費、瞬間），AI 修正才去要 —— 順序反過來的話，
  // 整張結果卡要等模型回來才看得到，而那幾秒裡使用者什麼都沒有
  render();
  const previous = current.turns[step - 1];
  reviewer.begin({
    key: reviewKey('dialogue', current.id, step),
    input,
    mode: aiMode('dialogue'),
    task: {
      mode: 'dialogue',
      reference: turn.answer,
      accept: turn.accept ?? [],
      intent_zh: turn.intent_zh,
      setting_zh: current.setting_zh,
      your_role_zh: current.your_role_zh,
      partner_role_zh: current.partner_role_zh,
      partner_line: previous?.speaker === 'partner' ? previous.en : '',
      // 只有 Gemini 那條路吃得到（OpenAI 相容端點的 model 在伺服器的 .env 裡）
      model: getSettings().geminiModel || undefined,
    },
  });
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
