import { h, clear, append } from '../lib/dom.js';
import { speak, isSupported as ttsSupported } from '../lib/tts.js';
import { buildQueue, recordAnswer, srsSummary, getCardState, resetSrs } from '../lib/storage.js';
import { filterBySettings, getSettings, updateSettings } from '../lib/settings.js';

export const meta = { id: 'vocabulary', label: '單字卡', icon: '🗂️' };

const CATEGORY_LABEL = { work: '職場', daily: '日常', travel: '旅遊', interview: '面試' };
const DIFFICULTY_LABEL = { easy: '簡單', medium: '中等', hard: '困難' };

let catalog = null;      // index.json
let deckId = null;       // 目前的牌組
let cards = [];
let queue = [];
let index = 0;
let revealed = false;
let picking = false;     // 是否停在選牌組的畫面
let root = null;

export async function mount(container) {
  root = container;

  const res = await fetch('/api/vocabulary/index.json');
  if (!res.ok) throw new Error(`讀取單字庫目錄失敗（HTTP ${res.status}）`);
  catalog = await res.json();

  const saved = getSettings().vocabDeck;
  const wanted = catalog.decks.find((d) => d.id === saved) ?? catalog.decks[0];
  await loadDeck(wanted.id);

  window.addEventListener('settings-changed', startSession);
  return () => { window.removeEventListener('settings-changed', startSession); root = null; };
}

async function loadDeck(id) {
  const deck = catalog.decks.find((d) => d.id === id);
  if (!deck) throw new Error(`找不到牌組 ${id}`);

  clear(root);
  append(root, h('p', { class: 'hint' }, `載入「${deck.label}」…`));

  const res = await fetch(`/api/vocabulary/${deck.file}`);
  if (!res.ok) throw new Error(`讀取單字失敗（HTTP ${res.status}）`);
  // 加上牌組前綴，避免不同牌組的相同 id 共用複習進度
  cards = (await res.json()).map((c) => ({ ...c, srsKey: `${id}:${c.id}` }));
  deckId = id;
  updateSettings({ vocabDeck: id });
  picking = false;
  startSession();
}

function startSession() {
  const pool = filterBySettings(cards);
  const { sessionLimit } = getSettings();
  queue = buildQueue(pool.length ? pool : cards);
  if (sessionLimit > 0) queue = queue.slice(0, sessionLimit);
  index = 0;
  revealed = false;
  render();
}

function render() {
  if (!root) return;
  clear(root);

  const pool = filterBySettings(cards);
  const summary = srsSummary(pool.length ? pool : cards);

  if (picking) return renderPicker();

  const deck = catalog.decks.find((d) => d.id === deckId);

  append(root, 
    h('div', { class: 'card' },
      h('div', { class: 'deckbar' },
        h('div', {},
          h('span', { class: 'deckbar__label' }, deck?.label ?? '單字'),
          h('span', { class: 'deckbar__count' }, `${deck?.count ?? cards.length} 字`),
        ),
        h('button', { class: 'btn btn--ghost', onclick: () => { picking = true; render(); } }, '切換牌組'),
      ),
      h('div', { class: 'srsbar' },
        stat('待複習', summary.due, 'due'),
        stat('未學過', summary.fresh, 'fresh'),
        stat('學習中', summary.learning, 'learning'),
        stat('已熟練', summary.mastered, 'mastered'),
      ),
    ),
  );

  if (queue.length === 0) {
    append(root, 
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
    append(root, 
      h('div', { class: 'card empty' },
        h('p', { class: 'empty__title' }, `這輪完成了！複習了 ${queue.length} 張`),
        h('button', { class: 'btn btn--primary', onclick: startSession }, '再來一輪'),
      ),
    );
    return;
  }

  const card = queue[index];
  const state = getCardState(card);

  append(root, 
    h('div', { class: 'card' },
      h('div', { class: 'card__meta' },
        card.category && h('span', { class: 'chip' }, CATEGORY_LABEL[card.category] ?? card.category),
        h('span', { class: 'chip chip--muted' }, DIFFICULTY_LABEL[card.difficulty] ?? card.difficulty),
        h('span', { class: 'chip chip--muted' }, `第 ${state.box} 盒`),
        h('span', { class: 'counter' }, `${index + 1} / ${queue.length}`),
      ),

      h('p', { class: 'vocab__word' }, card.word),
      h('p', { class: 'vocab__ipa' },
        h('span', { class: 'vocab__phonetic' }, card.ipa),
        h('span', { class: 'vocab__pos' }, card.pos),
      ),

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
        card.definition_en && h('p', { class: 'vocab__def' }, card.definition_en),
        card.example_en && h('p', { class: 'vocab__example' }, card.example_en),
        card.example_zh && h('p', { class: 'vocab__example-zh' }, card.example_zh),
        card.note_zh && h('p', { class: 'vocab__note' }, `💡 ${card.note_zh}`),
        card.tags?.length && h('p', { class: 'hint' }, `出現於：${card.tags.join('、')}`),
      ),
    ),
  );

  if (revealed) {
    append(root, 
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

function renderPicker() {
  clear(root);
  append(root, 
    h('div', { class: 'card' },
      h('p', { class: 'card__title' }, '選一組單字'),
      h('p', { class: 'hint' },
        `共 ${catalog.total.toLocaleString()} 個依詞頻排序的字，加上精選牌組。` +
        '詞頻越前面的越常出現在日常對話裡，建議從前面練起。'),
      h('div', { class: 'decklist' },
        catalog.decks.map((d) =>
          h('button', {
            class: 'deckitem' + (d.id === deckId ? ' deckitem--on' : ''),
            onclick: () => loadDeck(d.id).catch((err) => {
              clear(root);
              append(root, h('div', { class: 'banner banner--error' }, err.message));
            }),
          },
            h('span', { class: 'deckitem__label' }, d.label),
            h('span', { class: 'deckitem__count' }, `${d.count} 字`),
            d.note && h('span', { class: 'deckitem__note' }, d.note),
          )),
      ),
      h('p', { class: 'hint' }, `資料來源：${catalog.source}`),
    ),
  );
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
    if (card.example_en) await speak(card.example_en, { rate: 0.9 });
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
  recordAnswer(card, wasCorrect);
  index++;
  revealed = false;
  render();
}
