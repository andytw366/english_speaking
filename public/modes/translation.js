import { h, append } from '../lib/dom.js';
import { columns } from '../lib/layout.js';
import { categoryLabel, difficultyLabel } from '../lib/labels.js';
import { speak, isSupported as ttsSupported } from '../lib/tts.js';
import { getSettings, aiMode } from '../lib/settings.js';
import { recordPractice, recordOutcome, renderDailyCard } from '../lib/daily.js';
import { dueForSummary, renderDaySummary, markSummarySeen } from '../lib/day-summary.js';
import { grade, diffView } from '../lib/grade.js';
import { pickVerdict } from '../lib/verdict.js';
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
// 這一題的**模型判定**記進成績了沒。跟 `counted` 分開：今天的份在按下「對答案」
// 那一刻就要加上去，而模型的判定兩秒後才回來（也可能永遠不回來）。
let aiCounted = false;
let showHint = false;
// AI 修正。狀態、快取、那一段畫面都在 lib/ai-review.js（情境對話用的是同一份）
let reviewer = null;
// 今天的份練完了，停在總結那一頁。**擋在「下一題」上而不是在對答案的當下** ——
// 剛對完答案最想看的是自己這一句跟例句差在哪、AI 怎麼說，總結蓋上去等於把
// 那一題白答了（單字卡的 `!picked` 條件是同一個坑）。
let showingDaySummary = false;
let root = null;

export async function mount(container) {
  root = container;
  const res = await fetch('/api/content/translation');
  if (!res.ok) throw new Error(`讀取中翻英題目失敗（HTTP ${res.status}）`);
  all = await res.json();
  applyFilter();
  reviewer = createReviewer({ onChange: render, onResult: noteAiVerdict });
  showingDaySummary = false;
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

  // 停在總結那一頁時畫面上只有那幾顆按鈕，**空白鍵尤其要攔**
  if (showingDaySummary) {
    if (key === 'enter' || key === 'space' || key === 'n') { dismissDaySummary(); return true; }
    return false;
  }

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
  // 今天達標之後的第一次「下一題」先停在總結。看過就不再擋，想再練多少都可以。
  //
  // **`current` 要先有東西**：`mount()` 就是靠 `next()` 抽第一題的，
  // 少了這個條件的話，今天已經達標的人一進中翻英會看到一片空白
  // （總結畫出來了，但 `render()` 在 `current` 是 null 時直接 return）。
  if (current && !showingDaySummary && dueForSummary('translation')) {
    showingDaySummary = true;
    render();
    return;
  }
  let candidate = current;
  while (pool.length > 1 && candidate?.id === current?.id) {
    candidate = pool[Math.floor(Math.random() * pool.length)];
  }
  current = candidate ?? pool[0];
  // 換一題一定要離開總結。`mount()` 也是走這裡
  showingDaySummary = false;
  checked = null;
  counted = false;
  aiCounted = false;
  showHint = false;
  reviewer?.reset();
  render();
}

/** 看完今天的總結，換下一題。 */
function dismissDaySummary() {
  markSummarySeen('translation');
  showingDaySummary = false;
  next();
}

// ─── 畫面 ────────────────────────────────────────────────────────────────
function render() {
  if (!root || !current) return;
  const { main, side } = columns(root);

  append(side, renderDailyCard('translation'));

  // 總結自己占主欄（側欄的今天照舊留著）
  if (showingDaySummary) {
    append(main, renderDaySummary('translation', { onDismiss: dismissDaySummary }));
    return;
  }

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
 * **順序是刻意的**：判定 → 兩句並列（AI 改的在上、例句在下）→ AI 的說明
 * → 收起來的細節 → 按鈕。
 *
 * 為什麼 AI 那句排在最上面：使用者剛剛寫了一句話，他要的是「那到底該怎麼說」，
 * 而最貼近他寫的那一句的答案是模型改出來的那一句 —— 題目附的那句回答的是
 * 「這句中文可以怎麼講」，是另一個問題。以前 AI 那段接在整張卡的最後面，
 * 要先捲過逐字比對、其他說法、教材說明才看得到。
 *
 * **判定也是模型的**（`lib/verdict.js`）：題目附的答案只是一個例句，
 * 拿它當標準比對關鍵字會判錯 —— 而模型看的是使用者真正寫的那一句。
 * 模型沒看（關掉、手動還沒按、這次沒回來）才退回本地比對。
 *
 * 為什麼例句照樣在（而且緊接著）：它免費、離線、每次都一樣，
 * 而模型的意見每次不同也可能出錯 —— 兩句擺在一起才對照得出來。
 */
function resultCard() {
  const { level, missing } = checked.result;
  const input = checked.input;
  const { title, tone, source } = pickVerdict(reviewer, checked.result);
  const ai = reviewer.render();

  // 填空題的例句要**整句**（含填好的空格）—— 單獨一個字看不出它為什麼對
  const reference = current.type === 'cloze'
    ? current.sentence.replace('___', current.answer)
    : current.answer;

  const card = h('div', { class: `card result--${tone}` },
    h('p', { class: 'result__title' }, title),
    answerPair(
      ai.row,
      sentenceRow('📘 例句', reference, { tone: 'ref', speakText: reference }),
    ),
    ai.notes,
  );

  // 少了哪些關鍵用字：**只有退回本地比對時才講**。判定是模型給的時候，
  // 這一行講的是「例句裡有而你沒寫的字」—— 那跟結論沒有關係，
  // 而擺在一個說「這樣說可以」的判定下面，看起來就是自打嘴巴
  if (source === 'local' && level === 'wrong' && missing?.length) {
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
      }, '🔊 唸一次例句'),
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
    // 成績記的是**第一次**作答，跟今天的份同一條規則。「再試一次」改好了再記一次的話，
    // 正確率會變成「最後一次改對了沒」—— 那個數字誰都是 100%。
    recordPractice('translation', {
      result: { n: 1, ok: result.level === 'exact' || result.level === 'close' ? 1 : 0 },
    });
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

/**
 * 模型的判定回來了（或是從快取直接拿到的）。
 *
 * **要比對 key**：判定是非同步回來的，而使用者在等待的那幾秒裡可以換一題、
 * 也可以按「再試一次」重寫。對不上就丟掉，不然會記到別題頭上。
 * （情境對話的 `noteAiVerdict()` 是同一件事、同一個理由。）
 *
 * 一題只記一次（`aiCounted`）：「再試一次」而句子沒改時 `ai-review.js` 會直接
 * 從快取回報同一個判定，不擋的話同一題會被算兩次。
 */
function noteAiVerdict({ verdict, key }) {
  if (!current || aiCounted || key !== reviewKey('translation', current.id)) return;
  aiCounted = true;
  recordOutcome('translation', { aiN: 1, aiOk: verdict === 'ok' || verdict === 'minor' ? 1 : 0 });
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
