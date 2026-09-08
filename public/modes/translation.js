import { h, append } from '../lib/dom.js';
import { columns } from '../lib/layout.js';
import { categoryLabel, difficultyLabel } from '../lib/labels.js';
import { speak, isSupported as ttsSupported } from '../lib/tts.js';
import { getSettings, aiMode } from '../lib/settings.js';
import { recordPractice, renderDailyCard } from '../lib/daily.js';
import { grade, diffView, RESULT_HEAD } from '../lib/grade.js';
import { createReviewer, reviewKey } from '../lib/ai-review.js';
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

function resultCard() {
  const { level, missing } = checked.result;
  const input = checked.input;

  const [title, tone] = RESULT_HEAD[level];

  const card = h('div', { class: `card result--${tone}` },
    h('p', { class: 'result__title' }, title),
  );

  if (level === 'close') {
    append(card, h('p', { class: 'hint' }, '關鍵用字都有，只是說法跟參考答案不同 —— 這在翻譯裡很正常。'));
  }
  if (level === 'wrong' && missing?.length) {
    append(card, h('p', { class: 'hint' }, `少了這些關鍵用字：${missing.join('、')}`));
  }

  if (current.type === 'cloze') {
    append(card, 
      h('p', { class: 'trans__answer' },
        current.sentence.replace('___', current.answer)),
      level !== 'exact' && input
        ? h('p', { class: 'hint' }, `你填的是「${input}」`)
        : null,
      current.accept.length > 1
        ? h('p', { class: 'hint' }, `也可以填：${current.accept.filter((a) => a !== current.answer).join('、')}`)
        : null,
    );
  } else {
    append(card, diffView(input || '（空白）', current.answer));
    // 其他說法全部列出來，不是只列第一個。
    //
    // 從 Tatoeba 匯入的題目每題平均有 1.4 種說法、最多 8 種，而且那些都是
    // **真人寫的對等翻譯** —— 一句中文可以怎麼講，這裡是最有價值的一塊。
    // 只秀 accept[1] 的話，剩下的說法明明判得對卻看不到。
    const others = current.accept.slice(1);
    if (others.length > 0) {
      append(card,
        h('p', { class: 'hint' }, others.length === 1 ? '另一種說法：' : `其他說法（${others.length} 種）：`),
        h('ul', { class: 'trans__alts' }, others.map((a) => h('li', {}, a))),
      );
    }
  }

  // explain_zh 是手寫題目才有的欄位。從語料匯入的題目沒有 ——
  // 與其硬湊一句沒有內容的說明，不如把版面留給上面那些真正的說法。
  // （少了這道判斷會印出一個空的 <p>，畫面上是一段莫名其妙的空白。）
  if (current.explain_zh) {
    append(card, h('p', { class: 'explain explain--neutral' }, current.explain_zh));
  }

  // AI 修正接在參考答案**後面**，不是取代它 —— 兩者回答的是不同的問題：
  // 參考答案是「教材建議怎麼翻」，AI 修正是「我這樣翻行不行」
  append(card, reviewer.view());

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
