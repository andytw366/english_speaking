import { h, append } from '../lib/dom.js';
import { columns } from '../lib/layout.js';
import { categoryLabel, difficultyLabel } from '../lib/labels.js';
import { speak, isSupported as ttsSupported } from '../lib/tts.js';
import { getSettings, aiMode } from '../lib/settings.js';
import { recordPractice, renderDailyCard } from '../lib/daily.js';
import { grade, diffView, RESULT_HEAD } from '../lib/grade.js';
import { createReviewer, reviewKey } from '../lib/ai-review.js';
import { answerPair, sentenceRow, moreBox } from '../lib/answer-lines.js';
import { bindKeys } from '../lib/keys.js';

export const meta = { id: 'translation', label: '中翻英', icon: '✍️' };

const TYPE_LABEL = { cloze: '填空', sentence: '整句翻譯' };

let all = [];
let pool = [];
let current = null;
let checked = null;      // null = 還沒對答案
let counted = false;     // 這一題算進今天的進度了沒（「再試一次」不會再算一次）
let showHint = false;
// AI 修正。狀態、快取、那一段畫面都在 lib/ai-review.js（情境對話用的是同一份）
let reviewer = null;
let root = null;

export async function mount(container) {
  root = container;
  const res = await fetch('/api/content/translation');
  if (!res.ok) throw new Error(`讀取中翻英題目失敗（HTTP ${res.status}）`);
  all = await res.json();
  applyFilter();
  reviewer = createReviewer({ onChange: render });
  next();
  // 作答中的 Enter 由輸入框自己的 onEnter 處理（整句翻譯要能換行，所以是 ⌘+Enter）；
  // 這裡接的是**焦點不在輸入框時**的鍵。鍵的意思跟別的模式一致，見 lib/modes.js
  const unbindKeys = bindKeys(onKey);
  return () => { unbindKeys(); root = null; };
}

/**
 * 鍵盤。**一套共通的語言**（見 `lib/modes.js` 的說明）：
 * Enter 主要動作、N 換一題、S 唸出來、A 問 AI、H 提示。
 */
function onKey(key) {
  if (!root || !current) return false;

  if (key === 'n') { next(); return true; }

  if (!checked) {
    // 提示只有填空題有（整句翻譯的提示就是答案本身，給了等於直接看答案）
    if (key === 'h' && current.type === 'cloze' && current.hint_zh && !showHint) {
      showHint = true;
      render();
      return true;
    }
    return false;
  }

  if (key === 'enter' || key === 'space') { next(); return true; }
  if (key === 's') { root.querySelector('#btn-speak')?.click(); return true; }
  if (key === 'a') { root.querySelector('.airev button')?.click(); return true; }
  return false;
}

function applyFilter() {
  const { translationType } = getSettings();
  pool = translationType === 'all' ? all : all.filter((x) => x.type === translationType);
  if (pool.length === 0) pool = all;
}

function next() {
  let candidate = current;
  while (pool.length > 1 && candidate?.id === current?.id) {
    candidate = pool[Math.floor(Math.random() * pool.length)];
  }
  current = candidate ?? pool[0];
  checked = null;
  counted = false;
  showHint = false;
  reviewer?.reset();
  render();
}

// ─── 畫面 ────────────────────────────────────────────────────────────────
function render() {
  if (!root || !current) return;
  const { main, side } = columns(root);

  append(side, renderDailyCard('translation'));

  const isCloze = current.type === 'cloze';

  const card = h('div', { class: 'card' },
    h('div', { class: 'card__meta' },
      h('span', { class: 'chip' }, TYPE_LABEL[current.type]),
      h('span', { class: 'chip chip--muted' }, categoryLabel(current.category)),
      h('span', { class: 'chip chip--muted' }, difficultyLabel(current.difficulty)),
    ),
    h('p', { class: 'card__title' }, '把這句話翻成英文'),
    h('p', { class: 'trans__zh' }, current.zh),
  );

  if (isCloze) {
    const [before, after] = current.sentence.split('___');
    append(card, 
      h('p', { class: 'trans__cloze' },
        before,
        h('input', {
          class: 'trans__blank',
          id: 'answer',
          type: 'text',
          autocomplete: 'off',
          autocapitalize: 'off',
          spellcheck: 'false',
          placeholder: '?',
          value: checked?.input ?? '',
          disabled: Boolean(checked),
          onkeydown: onEnter,
        }),
        after,
      ),
    );
  } else {
    append(card, 
      h('textarea', {
        class: 'trans__input',
        id: 'answer',
        rows: '3',
        placeholder: '在這裡輸入英文翻譯…',
        autocapitalize: 'sentences',
        spellcheck: 'false',
        disabled: Boolean(checked),
        onkeydown: onEnter,
      }, checked?.input ?? ''),
    );
  }

  if (!checked) {
    append(card, 
      h('div', { class: 'row' },
        h('button', { class: 'btn btn--primary', onclick: check }, '對答案'),
        isCloze && current.hint_zh && !showHint &&
          h('button', { class: 'btn btn--link', onclick: () => { showHint = true; render(); } }, '💡 給我提示'),
        h('button', { class: 'btn btn--ghost', onclick: next }, '🔀 換一題'),
      ),
      showHint && current.hint_zh && h('p', { class: 'trans__hint' }, `💡 ${current.hint_zh}`),
      h('p', { class: 'hint' }, isCloze ? '按 Enter 也可以送出。' : '按 Ctrl/⌘ + Enter 送出。'),
    );
  }

  append(main, card);

  if (checked) append(main, resultCard());

  // 讓使用者可以直接打字，不用先點輸入框（對完答案就不搶焦點了）
  if (!checked) requestAnimationFrame(() => root?.querySelector('#answer')?.focus());
}

/**
 * 對完答案之後的那張卡。
 *
 * **順序是刻意的**：判定 → 兩句並列（AI 改的在上、參考答案在下）→ AI 的說明
 * → 收起來的細節 → 按鈕。
 *
 * 為什麼 AI 那句排在最上面：使用者剛剛寫了一句話，他要的是「那到底該怎麼說」，
 * 而最貼近他寫的那一句的答案是模型改出來的那一句 —— 教材的參考答案回答的是
 * 「這題的標準說法」，是另一個問題。以前 AI 那段接在整張卡的最後面，
 * 要先捲過逐字比對、其他說法、教材說明才看得到。
 *
 * 為什麼參考答案照樣在（而且緊接著）：它免費、離線、每次都一樣，
 * 而模型的意見每次不同也可能出錯 —— 兩句擺在一起才對照得出來。
 */
function resultCard() {
  const { level, missing } = checked.result;
  const input = checked.input;
  const [title, tone] = RESULT_HEAD[level];
  const ai = reviewer.render();

  // 填空題的參考答案要**整句**（含填好的空格）—— 單獨一個字看不出它為什麼對
  const reference = current.type === 'cloze'
    ? current.sentence.replace('___', current.answer)
    : current.answer;

  const card = h('div', { class: `card result--${tone}` },
    h('p', { class: 'result__title' }, title),
    answerPair(
      ai.row,
      sentenceRow('📘 參考答案', reference, { tone: 'ref', speakText: reference }),
    ),
    ai.notes,
  );

  // 少了哪些關鍵用字：這一行直接指出下一步要補什麼，所以不收起來
  if (level === 'wrong' && missing?.length) {
    append(card, h('p', { class: 'hint' }, `少了關鍵用字：${missing.join('、')}`));
  }

  // 其他說法留在外面（不收摺疊）：Tatoeba 匯入的題目每題平均 1.4 種、最多 8 種，
  // 而且都是**真人寫的對等翻譯** —— 一句中文可以怎麼講，這裡是最有價值的一塊
  const others = current.type === 'cloze'
    ? current.accept.filter((a) => a !== current.answer)
    : current.accept.slice(1);
  if (others.length > 0) {
    append(card,
      h('p', { class: 'hint' }, `也可以說（${others.length} 種）：`),
      h('ul', { class: 'trans__alts' }, others.map((a) => h('li', {}, a))),
    );
  }

  // 剩下的是「想追究的時候才看」的東西 —— 每一題都攤在畫面上的話，
  // 看第二十次就只是把按鈕擠到螢幕外面
  append(card, moreBox('看詳細比對',
    current.type === 'cloze'
      ? (level !== 'exact' && input ? h('p', { class: 'hint' }, `你填的是「${input}」`) : null)
      : diffView(input || '（空白）', current.answer),
    // explain_zh 是手寫題目才有的欄位，從語料匯入的沒有（少了這道判斷會印出空的 <p>）
    current.explain_zh && h('p', { class: 'explain explain--neutral' }, current.explain_zh),
    ai.credit,
  ));

  append(card,
    h('div', { class: 'row' },
      ttsSupported() && h('button', {
        class: 'btn btn--ghost', id: 'btn-speak',
        onclick: (e) => playAnswer(e.currentTarget),
      }, '🔊 唸一次答案'),
      h('button', { class: 'btn', onclick: () => { checked = null; reviewer.reset(); render(); } }, '再試一次'),
      h('button', { class: 'btn btn--primary', onclick: next }, '下一題'),
    ),
  );

  return card;
}

function onEnter(e) {
  if (e.key !== 'Enter') return;
  const isTextarea = e.currentTarget.tagName === 'TEXTAREA';
  // 整句翻譯要能換行，所以用 Ctrl/⌘ + Enter 送出
  if (isTextarea && !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  check();
}

function check() {
  const el = root?.querySelector('#answer');
  const input = el?.value ?? '';
  const result = grade({ ...current, strict: current.type === 'cloze' }, input);

  // 空白的答案不算練習 —— 一路按「對答案」不該累積出今天的進度。
  // 一題只記一次：「再試一次」會把 checked 清成 null，所以不能拿它當判斷依據，
  // 要用一個跟著題目走的旗標。
  if (result.level !== 'empty' && !counted) {
    counted = true;
    recordPractice('translation');
  }

  checked = { input, result };
  render();

  // 空白作答不去要修正（沒有東西可以改，而那仍然是一次要花錢的呼叫）——
  // reviewer 自己會擋，這裡不必再判一次
  //
  // 填空題除了「他填了什麼」還要送**句型**（`sentence`，含 ___）：
  // 「grab」單獨看不出對錯，模型要看得到整句才知道那個位置該用什麼詞
  reviewer.begin({
    key: reviewKey('translation', current.id),
    input,
    mode: aiMode('translation'),
    task: {
      mode: 'translation',
      zh: current.zh,
      type: current.type,
      sentence: current.sentence ?? '',
      reference: current.answer,
      accept: current.accept ?? [],
      model: getSettings().geminiModel || undefined,
    },
  });
}

async function playAnswer(button) {
  const text = current.type === 'cloze'
    ? current.sentence.replace('___', current.answer)
    : current.answer;
  button.disabled = true;
  try {
    await speak(text);
  } catch (err) {
    console.error('[tts]', err);
  } finally {
    button.disabled = false;
  }
}
