import { h, clear } from '../lib/dom.js';
import { speak, isSupported as ttsSupported } from '../lib/tts.js';
import { getSettings } from '../lib/settings.js';

export const meta = { id: 'translation', label: '中翻英', icon: '✍️' };

const CATEGORY_LABEL = { work: '職場', daily: '日常', travel: '旅遊', interview: '面試' };
const DIFFICULTY_LABEL = { easy: '簡單', medium: '中等', hard: '困難' };
const TYPE_LABEL = { cloze: '填空', sentence: '整句翻譯' };

let all = [];
let pool = [];
let current = null;
let checked = null;      // null = 還沒對答案
let showHint = false;
let root = null;

export async function mount(container) {
  root = container;
  const res = await fetch('/api/content/translation');
  if (!res.ok) throw new Error(`讀取中翻英題目失敗（HTTP ${res.status}）`);
  all = await res.json();
  applyFilter();
  next();
  return () => { root = null; };
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
  showHint = false;
  render();
}

// ─── 比對 ────────────────────────────────────────────────────────────────
function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[.,!?;:"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return normalize(s).split(' ').filter(Boolean);
}

/**
 * 整句翻譯很難精確自動批改 —— 同一個意思有很多種講法。
 * 所以分三級：完全相符、關鍵字都有（算通過但提示參考答案）、差太多。
 */
function grade(item, input) {
  const got = normalize(input);
  if (!got) return { level: 'empty' };

  const exact = item.accept.some((a) => normalize(a) === got);
  if (exact) return { level: 'exact' };

  if (item.type === 'cloze') {
    return { level: 'wrong' };
  }

  const gotTokens = new Set(tokens(input));
  const missing = (item.keywords ?? []).filter(
    (kw) => !tokens(kw).every((t) => gotTokens.has(t))
  );
  if (missing.length === 0) return { level: 'close' };
  return { level: 'wrong', missing };
}

/** 逐字比對使用者的答案與參考答案，標出差異 */
function diffView(userText, referenceText) {
  const a = tokens(userText);
  const b = tokens(referenceText);
  const setB = new Set(b);
  const setA = new Set(a);

  const userWords = userText.trim().split(/\s+/);
  return h('div', { class: 'diff' },
    h('p', { class: 'diff__label' }, '你的答案'),
    h('p', { class: 'diff__line' },
      userWords.map((w, i) => {
        const ok = setB.has(normalize(w));
        return [h('span', { class: ok ? 'dword' : 'dword dword--extra' }, w),
                i < userWords.length - 1 ? ' ' : ''];
      })),
    h('p', { class: 'diff__label' }, '參考答案'),
    h('p', { class: 'diff__line' },
      referenceText.split(/\s+/).map((w, i) => {
        const hit = setA.has(normalize(w));
        return [h('span', { class: hit ? 'dword' : 'dword dword--missing' }, w),
                i < referenceText.split(/\s+/).length - 1 ? ' ' : ''];
      })),
    h('p', { class: 'hint' }, '紅色＝參考答案有但你沒寫到；灰色底＝你多寫的。意思對就好，用字不必完全一樣。'),
  );
}

// ─── 畫面 ────────────────────────────────────────────────────────────────
function render() {
  if (!root || !current) return;
  clear(root);

  const isCloze = current.type === 'cloze';

  const card = h('div', { class: 'card' },
    h('div', { class: 'card__meta' },
      h('span', { class: 'chip' }, TYPE_LABEL[current.type]),
      h('span', { class: 'chip chip--muted' }, CATEGORY_LABEL[current.category] ?? current.category),
      h('span', { class: 'chip chip--muted' }, DIFFICULTY_LABEL[current.difficulty] ?? current.difficulty),
    ),
    h('p', { class: 'card__title' }, '把這句話翻成英文'),
    h('p', { class: 'trans__zh' }, current.zh),
  );

  if (isCloze) {
    const [before, after] = current.sentence.split('___');
    card.append(
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
    card.append(
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
    card.append(
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

  root.append(card);

  if (checked) root.append(resultCard());

  // 讓使用者可以直接打字，不用先點輸入框（對完答案就不搶焦點了）
  if (!checked) requestAnimationFrame(() => root?.querySelector('#answer')?.focus());
}

function resultCard() {
  const { level, missing } = checked.result;
  const input = checked.input;

  const HEAD = {
    exact: ['✅ 完全正確！', 'ok'],
    close: ['🟡 意思對了', 'close'],
    wrong: ['❌ 再想想', 'bad'],
    empty: ['請先寫下答案', 'bad'],
  };
  const [title, tone] = HEAD[level];

  const card = h('div', { class: `card result--${tone}` },
    h('p', { class: 'result__title' }, title),
  );

  if (level === 'close') {
    card.append(h('p', { class: 'hint' }, '關鍵用字都有，只是說法跟參考答案不同 —— 這在翻譯裡很正常。'));
  }
  if (level === 'wrong' && missing?.length) {
    card.append(h('p', { class: 'hint' }, `少了這些關鍵用字：${missing.join('、')}`));
  }

  if (current.type === 'cloze') {
    card.append(
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
    card.append(diffView(input || '（空白）', current.answer));
    if (current.accept.length > 1) {
      card.append(h('p', { class: 'hint' }, `另一種說法：${current.accept[1]}`));
    }
  }

  card.append(h('p', { class: 'explain explain--neutral' }, current.explain_zh));

  card.append(
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
  checked = { input, result: grade(current, input) };
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
