import { h, clear } from '../lib/dom.js';
import { speak, isSupported as ttsSupported } from '../lib/tts.js';
import { buildQueue, recordAnswer, srsSummary, getCardState, resetSrs } from '../lib/storage.js';

export const meta = { id: 'vocabulary', label: '單字卡', icon: '🗂️' };

const CATEGORY_LABEL = { work: '職場', daily: '日常', travel: '旅遊', interview: '面試' };
const DIFFICULTY_LABEL = { easy: '簡單', medium: '中等', hard: '困難' };

let cards = [];
let queue = [];
let index = 0;
let revealed = false;
let root = null;

export async function mount(container) {
  root = container;
  const res = await fetch('/api/content/vocabulary');
  if (!res.ok) throw new Error(`讀取單字卡失敗（HTTP ${res.status}）`);
  cards = await res.json();
  startSession();
  return () => { root = null; };
}

function startSession() {
  queue = buildQueue(cards);
  index = 0;
  revealed = false;
  render();
}

function render() {
  if (!root) return;
  clear(root);

  const summary = srsSummary(cards);

  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'srsbar' },
        stat('待複習', summary.due, 'due'),
        stat('未學過', summary.fresh, 'fresh'),
        stat('學習中', summary.learning, 'learning'),
        stat('已熟練', summary.mastered, 'mastered'),
      ),
    ),
  );

  if (queue.length === 0) {
    root.append(
      h('div', { class: 'card empty' },
        h('p', { class: 'empty__title' }, '目前沒有需要複習的卡片 🎉'),
        h('p', { class: 'hint' },
          `全部 ${summary.total} 張都排進了複習排程，時間到了會再出現。` +
          '間隔是 1 天 → 3 天 → 7 天 → 21 天，答錯會回到第一天。'),
        h('button', { class: 'btn', onclick: () => { resetSrs(); startSession(); } }, '重設所有進度'),
      ),
    );
    return;
  }

  if (index >= queue.length) {
    root.append(
      h('div', { class: 'card empty' },
        h('p', { class: 'empty__title' }, `這輪完成了！複習了 ${queue.length} 張`),
        h('button', { class: 'btn btn--primary', onclick: startSession }, '再來一輪'),
      ),
    );
    return;
  }

  const card = queue[index];
  const state = getCardState(card.id);

  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'card__meta' },
        h('span', { class: 'chip' }, CATEGORY_LABEL[card.category] ?? card.category),
        h('span', { class: 'chip chip--muted' }, DIFFICULTY_LABEL[card.difficulty] ?? card.difficulty),
        h('span', { class: 'chip chip--muted' }, `第 ${state.box} 盒`),
        h('span', { class: 'counter' }, `${index + 1} / ${queue.length}`),
      ),

      h('p', { class: 'vocab__word' }, card.word),
      h('p', { class: 'vocab__ipa' }, `${card.ipa}　${card.pos}`),

      h('div', { class: 'row' },
        ttsSupported() && h('button', {
          class: 'btn btn--ghost',
          onclick: (e) => playWord(card, e.currentTarget),
        }, '🔊 唸這個字'),
        !revealed && h('button', {
          class: 'btn btn--primary',
          onclick: () => { revealed = true; render(); },
        }, '顯示答案'),
      ),

      revealed && h('div', { class: 'vocab__back' },
        h('p', { class: 'vocab__meaning' }, card.meaning_zh),
        h('p', { class: 'vocab__example' }, card.example_en),
        h('p', { class: 'vocab__example-zh' }, card.example_zh),
        card.note_zh && h('p', { class: 'vocab__note' }, `💡 ${card.note_zh}`),
      ),
    ),
  );

  if (revealed) {
    root.append(
      h('div', { class: 'card' },
        h('p', { class: 'card__title' }, '剛剛記得嗎？'),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn--danger', onclick: () => answer(card, false) }, '還不熟'),
          h('button', { class: 'btn btn--primary', onclick: () => answer(card, true) }, '記得'),
        ),
        h('p', { class: 'hint' }, '「還不熟」會把這張卡放回第 1 盒，明天再出現。'),
      ),
    );
  }
}

function stat(label, value, kind) {
  return h('div', { class: `srsstat srsstat--${kind}` },
    h('span', { class: 'srsstat__value' }, String(value)),
    h('span', { class: 'srsstat__label' }, label),
  );
}

async function playWord(card, button) {
  const original = button.textContent;
  button.disabled = true;
  try {
    // 先唸單字，再唸例句，中間讓 speak 自己等唸完
    await speak(card.word, { rate: 0.85 });
    await speak(card.example_en, { rate: 0.9 });
  } catch (err) {
    button.textContent = '⚠️ 無法播放';
    console.error('[tts]', err);
    setTimeout(() => { button.textContent = original; }, 2000);
    return;
  } finally {
    button.disabled = false;
  }
}

function answer(card, wasCorrect) {
  recordAnswer(card.id, wasCorrect);
  index++;
  revealed = false;
  render();
}
