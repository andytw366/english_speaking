import { h, append } from '../lib/dom.js';
import { columns } from '../lib/layout.js';
import { categoryLabel, difficultyLabel } from '../lib/labels.js';
import { speak, isSupported as ttsSupported } from '../lib/tts.js';
import { getSettings } from '../lib/settings.js';
import { recordPractice, renderDailyCard } from '../lib/daily.js';
import { grade, diffView, RESULT_HEAD } from '../lib/grade.js';
import { bindKeys } from '../lib/keys.js';

export const meta = { id: 'translation', label: '中翻英', icon: '✍️' };

const TYPE_LABEL = { cloze: '填空', sentence: '整句翻譯' };

let all = [];
let pool = [];
let current = null;
let checked = null;      // null = 還沒對答案
let counted = false;     // 這一題算進今天的進度了沒（「再試一次」不會再算一次）
let showHint = false;
let root = null;

export async function mount(container) {
  root = container;
  const res = await fetch('/api/content/translation');
  if (!res.ok) throw new Error(`讀取中翻英題目失敗（HTTP ${res.status}）`);
  all = await res.json();
  applyFilter();
  next();
  // 作答中的 Enter 由輸入框自己的 onEnter 處理（整句翻譯要能換行，所以是 ⌘+Enter）；
  // 這裡接的是**對完答案之後**的 Enter —— 那時輸入框是 disabled 的，焦點不在裡面
  const unbindKeys = bindKeys((key) => {
    if (!checked) return false;
    if (key === 'enter' || key === 'space') { next(); return true; }
    return false;
  });
  return () => { unbindKeys(); root = null; };
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
    if (current.accept.length > 1) {
      append(card, h('p', { class: 'hint' }, `另一種說法：${current.accept[1]}`));
    }
  }

  append(card, h('p', { class: 'explain explain--neutral' }, current.explain_zh));

  append(card, 
    h('div', { class: 'row' },
      ttsSupported() && h('button', {
        class: 'btn btn--ghost',
        onclick: (e) => playAnswer(e.currentTarget),
      }, '🔊 唸一次答案'),
      h('button', { class: 'btn', onclick: () => { checked = null; render(); } }, '再試一次'),
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
