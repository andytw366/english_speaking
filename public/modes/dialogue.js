import { h, append } from '../lib/dom.js';
import { columns } from '../lib/layout.js';
import { bindKeys } from '../lib/keys.js';
import { categoryLabel, difficultyLabel } from '../lib/labels.js';
import { speak, stop as stopTts, isSupported as ttsSupported } from '../lib/tts.js';
import { filterBySettings, getSettings } from '../lib/settings.js';
import { recordPractice, renderDailyCard } from '../lib/daily.js';
import { grade, diffView, normalize, RESULT_HEAD } from '../lib/grade.js';
import {
  aiReviewAvailability, requestDialogueReview, VERDICT_HEAD,
} from '../lib/ai-review.js';
import { Recorder, isSupported as recSupported, describeMicError, MAX_RECORDING_MS } from '../lib/recorder.js';

export const meta = { id: 'dialogue', label: '情境對話', icon: '💬' };


let all = [];
let current = null;
let step = 0;            // 目前進行到第幾個 turn
let checked = null;      // 這一輪的作答結果
let revealed = false;    // 有沒有先看參考說法
let scores = [];         // 每個「你的台詞」的判定結果
// AI 修正這一輪的狀態：null（還沒要）| { state: 'loading' | 'done' | 'error', … }
let review = null;
// 每要一次修正就 +1。回應回來時對不上就丟掉 —— 請求還在飛的時候按「繼續對話」，
// 上一句的修正會蓋在下一句的畫面上，而那個 bug 只有手速快的時候才出現
let reviewToken = 0;
// 伺服器有沒有一條可以呼叫的模型。null = 還不知道（那一趟請求還沒回來或掉了），
// **不知道時當作可以試** —— 說死「不能用」的代價是使用者以為功能壞了
let aiReady = null;
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
  start(all[Math.floor(Math.random() * all.length)]);
  unbindKeys = bindKeys(onKey);
  // 不 await，也**不因此重畫**：AI 修正只出現在「對答案」之後的那張卡，
  // 而這時候使用者可能正在輸入框裡打字 —— 為了一個還沒要顯示的東西重畫，
  // 打到一半的字會消失
  aiReviewAvailability().then((info) => { aiReady = info; });
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

  if (key === 'p') {
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('再聽一次'));
    if (!btn) return false;
    btn.click();
    return true;
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
  resetReview();
  resetRecording();
  render();
  // 如果第一句是對方講的，直接唸出來
  maybeSpeakPartner();
}

/**
 * 丟掉這一輪的 AI 修正。**token 也要 +1** —— 只清掉 review 的話，
 * 還在飛的那個請求回來時會把自己畫到下一句的畫面上。
 */
function resetReview() {
  review = null;
  reviewToken++;
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
  resetReview();
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

  // AI 修正接在參考答案**後面**，不是取代它。
  // 參考答案是教材寫死的（免費、離線、每次都一樣），AI 看的是「你自己那句」——
  // 兩個回答的是不同的問題，所以兩個都要在
  append(card, reviewBlock());

  // 知道正確說法之後再練發音才有意義，所以錄音放在這裡而不是作答前
  if (recSupported()) append(card, recordingRow(turn.answer));

  append(card, 
    h('div', { class: 'row' },
      ttsSupported() && h('button', {
        class: 'btn btn--ghost',
        onclick: (e) => replay(turn.answer, e.currentTarget),
      }, '🔊 唸一次參考說法'),
      h('button', { class: 'btn', onclick: () => { checked = null; resetReview(); render(); } }, '再試一次'),
      h('button', { class: 'btn btn--primary', onclick: advance },
        step === current.turns.length - 1 ? '完成對話 →' : '繼續對話 →'),
    ),
  );
  return card;
}

/**
 * 「AI 怎麼看你這一句」。**永遠不會取代參考答案** —— 它接在那些東西後面。
 *
 * 四種狀態各自要說不同的話，而分不清楚的代價都是「以為壞了」：
 *   還沒要（自動修正關掉時）→ 一個按鈕，按了才花錢
 *   要不到（伺服器沒設定模型）→ 講清楚要去哪裡設定，不要給一個按了也沒用的按鈕
 *   正在要 → 明講在等什麼，不然那幾秒看起來像卡住
 *   要到了 / 這次沒回來 → 前者顯示修正，後者給一個「再要一次」
 */
function reviewBlock() {
  const box = h('div', { class: 'airev' });

  // 空白作答不給按鈕：沒有東西可以改，而那仍然是一次要花錢的呼叫
  if (!checked?.input?.trim()) return box;

  if (review?.state === 'loading') {
    append(box, h('p', { class: 'status status--busy' }, '🤖 AI 正在看你寫的這一句…'));
    return box;
  }

  if (review?.state === 'error') {
    append(box,
      // 前面加上機器人：這一行講的是 AI 修正的事，而它前面就是教材的參考答案 ——
      // 沒有記號的話看起來像在說剛才那次作答出了什麼問題
      h('p', { class: 'hint hint--warn' }, `🤖 ${review.message}`),
      // 沒設定模型時不給「再要一次」—— 按幾次都會是同一個結果
      review.reason !== 'no_key' && h('button', { class: 'btn btn--ghost', onclick: askAi },
        '🤖 再要一次'),
    );
    return box;
  }

  if (review?.state === 'done') {
    append(box, reviewResult(review));
    return box;
  }

  // 還沒要。伺服器那邊根本沒有模型可用的話，給的是說明而不是按鈕
  if (aiReady && aiReady.ready === false) {
    append(box, h('p', { class: 'hint' },
      `🤖 AI 修正目前不能用（${aiReady.problem}）。` +
      '設定好之後，這裡會多一段「你這句話本身怎麼樣」的建議。'));
    return box;
  }

  append(box,
    h('button', { class: 'btn btn--ghost', onclick: askAi }, '🤖 讓 AI 看我這一句'),
    h('p', { class: 'hint' }, '會把你的句子連同這個情境送給伺服器設定的模型，換一句更自然的說法。'),
  );
  return box;
}

/** 修正回來之後長什麼樣。 */
function reviewResult({ data, label, ms }) {
  const [title, tone] = VERDICT_HEAD[data.verdict] ?? VERDICT_HEAD.minor;
  const box = h('div', { class: `airev__box airev__box--${tone}` },
    h('p', { class: 'airev__title' }, title),
  );

  // 模型把原句照抄回來時不要再秀一次一模一樣的句子 —— 那只會讓人以為它沒看懂
  const unchanged = data.corrected && normalize(data.corrected) === normalize(checked.input);

  if (data.corrected && !unchanged) {
    append(box,
      h('p', { class: 'airev__line' },
        data.corrected,
        ttsSupported() && h('button', {
          class: 'bubble__play',
          title: '唸這一句',
          onclick: (e) => replay(data.corrected, e.currentTarget),
        }, '🔊'),
      ),
    );
  } else if (unchanged) {
    append(box, h('p', { class: 'hint' }, '你原本那句就可以直接用，不用改。'));
  }

  for (const note of data.notes ?? []) {
    append(box, h('p', { class: 'airev__note' }, `• ${note}`));
  }

  append(box, h('p', { class: 'airev__by' },
    `由 ${label ?? '伺服器設定的模型'} 產生` +
    (typeof ms === 'number' ? `，等了 ${(ms / 1000).toFixed(1)} 秒` : '') +
    '。這是模型的意見，跟上面教材的參考答案不一樣是正常的。'));

  return box;
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
  resetReview();
  render();

  // 本地批改先出現（免費、瞬間），AI 修正才去要 —— 順序反過來的話，
  // 整張結果卡要等模型回來才看得到，而那幾秒裡使用者什麼都沒有
  if (getSettings().dialogueAiReview !== false) askAi();
}

/**
 * 去要一次 AI 修正。空白的答案不送 —— 沒有東西可以改，而那仍然是一次呼叫。
 *
 * 送出去的東西見 `server/coach.js` 的 `parseReviewRequest()`：情境、角色、
 * 對方剛剛說的話都要帶上，少了它們模型只能就句子論句子，
 * 而同一句話在咖啡店與在藥局是完全不同的評語。
 */
function askAi() {
  const turn = currentTurn();
  const input = checked?.input?.trim();
  if (!turn || !input) return;

  const previous = current.turns[step - 1];
  const token = ++reviewToken;
  review = { state: 'loading' };
  render();

  requestDialogueReview({
    input,
    reference: turn.answer,
    accept: turn.accept ?? [],
    intent_zh: turn.intent_zh,
    setting_zh: current.setting_zh,
    your_role_zh: current.your_role_zh,
    partner_role_zh: current.partner_role_zh,
    partner_line: previous?.speaker === 'partner' ? previous.en : '',
    // 只有 Gemini 那條路吃得到（OpenAI 相容端點的 model 在伺服器的 .env 裡）
    model: getSettings().geminiModel || undefined,
  }).then((out) => {
    // 對不上 token 就是「這已經不是剛才那一句了」—— 直接丟掉
    if (token !== reviewToken || !root) return;
    review = out.ok
      ? { state: 'done', data: out.review, label: out.label, ms: out.ms }
      : { state: 'error', reason: out.reason, message: out.message };
    render();
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
