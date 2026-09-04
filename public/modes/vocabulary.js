import { h, clear, append } from '../lib/dom.js';
import { categoryLabel, difficultyLabel } from '../lib/labels.js';
import { speak, isSupported as ttsSupported } from '../lib/tts.js';
import {
  buildQueue, recordAnswer, srsSummary, getCardState, resetSrs,
  getSrsState, tierProgress,
} from '../lib/storage.js';
import { filterBySettings, getSettings, updateSettings } from '../lib/settings.js';

export const meta = { id: 'vocabulary', label: '單字卡', icon: '🗂️' };

// 熟練到這個比例（或沒學過的剩不到 10%）就建議往上一級。
// 不自動跳級 —— 使用者自己選難度，這裡只提醒。
const ADVANCE_MASTERED = 0.8;
const ADVANCE_FRESH_LEFT = 0.1;

let catalog = null;      // index.json
let tierMap = null;      // tier-map.json，各級進度用（載不到就不顯示總覽）
let deckId = null;       // 目前的牌組
let cards = [];
let queue = [];
let index = 0;
let revealed = false;
let picking = false;     // 是否停在選難度的畫面
let showBands = false;   // 詞頻級距預設收起來 —— 分級才是主要的選法
let root = null;

export async function mount(container) {
  root = container;

  const res = await fetch('/api/vocabulary/index.json');
  if (!res.ok) throw new Error(`讀取單字庫目錄失敗（HTTP ${res.status}）`);
  catalog = await res.json();

  // 各級進度的對照表。20 KB，載不到不是致命錯誤 —— 只是總覽不畫，練習照常。
  if (catalog.tierMapFile) {
    try {
      const r = await fetch(`/api/vocabulary/${catalog.tierMapFile}`);
      tierMap = r.ok ? await r.json() : null;
    } catch {
      tierMap = null;
    }
  }

  const saved = getSettings().vocabDeck;
  const wanted = catalog.decks.find((d) => d.id === saved) ?? catalog.decks[0];
  await loadDeck(wanted.id);

  window.addEventListener('settings-changed', startSession);
  return () => { window.removeEventListener('settings-changed', startSession); root = null; };
}

const decks = () => catalog?.decks ?? [];
const deckOf = (id) => decks().find((d) => d.id === id);
const tierDecks = () => decks().filter((d) => d.kind === 'tier');
const bandDecks = () => decks().filter((d) => d.kind === 'band');

async function loadDeck(id) {
  const deck = deckOf(id);
  if (!deck) throw new Error(`找不到牌組 ${id}`);

  clear(root);
  append(root, h('p', { class: 'hint' }, `載入「${deck.label}」…`));

  const res = await fetch(`/api/vocabulary/${deck.file}`);
  if (!res.ok) throw new Error(`讀取單字失敗（HTTP ${res.status}）`);
  // 複習進度的鍵用牌組的 keyspace，不是牌組 id —— 難度分級與詞頻級距是同一批字
  // 的兩種切法，共用 `ecdict`，所以在 band-1 記熟的字換去 tier-1 練不會變回
  // 「沒學過」。精選的 id 會跟 ECDICT 的字撞，所以它自己一個 keyspace。
  // （舊資料沒有 keyspace 欄位時退回牌組 id，行為跟以前一樣。）
  const keyspace = deck.keyspace ?? id;
  cards = (await res.json()).map((c) => ({ ...c, srsKey: `${keyspace}:${c.id}` }));
  deckId = id;
  updateSettings({ vocabDeck: id });
  picking = false;
  startSession();
}

/**
 * 這一輪要練的卡。
 *
 * 「從我在的難度抽固定數量」就是這裡：`buildQueue()` 先排到期的、再補沒學過的，
 * 然後用設定裡的 `sessionLimit`（預設 20）切掉尾巴。
 */
function currentPool() {
  const deck = deckOf(deckId);
  // 精選牌組是手寫的，有 category 與 difficulty，所以照設定的練習範圍過濾。
  // ECDICT 的分級與級距**不套用難度篩選** —— 難度已經是使用者選的那一級了，
  // 再拿詞頻換算出來的 easy/medium/hard 篩一次，只會讓一級裡的字莫名少一半。
  if (deck?.keyspace === 'curated') {
    const filtered = filterBySettings(cards);
    return filtered.length ? filtered : cards;
  }
  return cards;
}

function startSession() {
  const { sessionLimit } = getSettings();
  queue = buildQueue(currentPool());
  if (sessionLimit > 0) queue = queue.slice(0, sessionLimit);
  index = 0;
  revealed = false;
  render();
}

function render() {
  if (!root) return;
  clear(root);

  if (picking) return renderPicker();

  const deck = deckOf(deckId);
  const summary = srsSummary(currentPool());

  append(root, deckCard(deck, summary));

  if (queue.length === 0) {
    append(root,
      h('div', { class: 'card empty' },
        h('p', { class: 'empty__title' }, '這一級目前沒有需要複習的卡片 🎉'),
        h('p', { class: 'hint' },
          `${summary.total} 張都排進了複習排程，時間到了會再出現。` +
          '間隔是 1 天 → 3 天 → 7 天 → 21 天，答錯會回到第一天。'),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn--primary', onclick: () => { picking = true; render(); } }, '換一個難度'),
          h('button', { class: 'btn btn--ghost', onclick: () => { resetSrs(); startSession(); } }, '重設所有進度'),
        ),
      ),
    );
    return;
  }

  if (index >= queue.length) {
    append(root,
      h('div', { class: 'card empty' },
        h('p', { class: 'empty__title' }, `這輪完成了！複習了 ${queue.length} 張`),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn--primary', onclick: startSession }, '再來一輪'),
          h('button', { class: 'btn btn--ghost', onclick: () => { picking = true; render(); } }, '換難度'),
        ),
      ),
    );
    return;
  }

  append(root, cardFace(queue[index]));

  if (revealed) {
    const card = queue[index];
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

// ─── 我在第幾級 ──────────────────────────────────────────────────────────
function deckCard(deck, summary) {
  const tiers = tierDecks();
  const order = deck?.kind === 'tier' ? deck.order : null;
  const next = order ? tiers.find((t) => t.order === order + 1) : null;

  return h('div', { class: 'card' },
    h('div', { class: 'deckbar' },
      h('div', {},
        h('span', { class: 'deckbar__label' }, deck?.label ?? '單字'),
        h('span', { class: 'deckbar__count' },
          (order ? `第 ${order} 級 / 共 ${tiers.length} 級・` : '') +
          `${(deck?.count ?? cards.length).toLocaleString()} 字`),
      ),
      h('button', {
        class: 'btn btn--ghost',
        onclick: () => { picking = true; render(); },
      }, deck?.kind === 'tier' ? '換難度' : '選難度'),
    ),

    progressBar(summary.mastered, summary.learning, summary.total),

    h('div', { class: 'srsbar' },
      stat('待複習', summary.due, 'due'),
      stat('未學過', summary.fresh, 'fresh'),
      stat('學習中', summary.learning, 'learning'),
      stat('已熟練', summary.mastered, 'mastered'),
    ),

    h('p', { class: 'hint' },
      `這一輪最多 ${getSettings().sessionLimit || '不限'} 張` +
      (getSettings().sessionLimit ? '（在「設定」可以改）' : '') +
      '，先排到期要複習的，再補沒學過的。'),

    // 不自動跳級：難度是使用者自己選的，這裡只在該畢業的時候提醒一次
    next && shouldAdvance(summary) && h('div', { class: 'banner' },
      `這一級已經熟練 ${Math.round((summary.mastered / summary.total) * 100)}%。`,
      h('button', {
        class: 'btn btn--primary',
        onclick: () => loadDeck(next.id).catch(showError),
      }, `進到「${next.label}」`),
    ),
  );
}

function shouldAdvance(summary) {
  if (!summary.total) return false;
  return summary.mastered / summary.total >= ADVANCE_MASTERED ||
    summary.fresh / summary.total <= ADVANCE_FRESH_LEFT;
}

/** 兩段式進度條：已熟練（綠）＋學習中（藍），剩下的是還沒學過。 */
function progressBar(mastered, learning, total) {
  const pct = (n) => (total > 0 ? `${(n / total) * 100}%` : '0%');
  return h('span', { class: 'tierbar' },
    h('span', { class: 'tierbar__fill tierbar__fill--mastered', style: `width:${pct(mastered)}` }),
    h('span', { class: 'tierbar__fill tierbar__fill--learning', style: `width:${pct(learning)}` }),
  );
}

// ─── 選難度 ──────────────────────────────────────────────────────────────
function renderPicker() {
  clear(root);

  // 各級進度只需要 tier-map（20 KB）加 localStorage 就算得出來，
  // 不必把六個分級檔（3 MB）全部載下來。
  const progress = tierMap ? tierProgress(getSrsState(), tierMap) : [];
  const byId = new Map(progress.map((p) => [p.id, p]));

  append(root,
    h('div', { class: 'card' },
      h('p', { class: 'card__title' }, '選難度'),
      h('p', { class: 'hint' },
        `共 ${(catalog.total ?? 0).toLocaleString()} 個字，依 ECDICT 的考試範圍分成 ` +
        `${tierDecks().length} 級（國中 → 高中 → 四級 → 六級 → 檢定 → GRE）。` +
        '一個字同時屬於多個範圍時算最簡單的那一個。'),
      h('div', { class: 'decklist' },
        tierDecks().map((d) => deckItem(d, byId.get(d.id)))),
      !tierMap && h('p', { class: 'hint' }, '（讀不到各級進度的對照表，所以只顯示字數。）'),
    ),

    h('div', { class: 'card' },
      h('p', { class: 'card__title' }, '精選'),
      h('div', { class: 'decklist' },
        decks().filter((d) => d.kind === 'curated').map((d) => deckItem(d, null))),
    ),

    h('div', { class: 'card' },
      h('div', { class: 'deckbar' },
        h('div', {},
          h('span', { class: 'deckbar__label' }, '依詞頻級距'),
          h('span', { class: 'deckbar__count' }, `${bandDecks().length} 組・每組 1,000 字`),
        ),
        h('button', {
          class: 'btn btn--ghost',
          onclick: () => { showBands = !showBands; render(); },
        }, showBands ? '收起' : '展開'),
      ),
      h('p', { class: 'hint' },
        '按「第幾個 1,000 常用」切的舊分組。跟上面的分級是同一批字、' +
        '複習進度也共用 —— 想照詞頻順序練的時候才需要它。'),
      showBands && h('div', { class: 'decklist' }, bandDecks().map((d) => deckItem(d, null))),
    ),

    h('div', { class: 'card' },
      h('p', { class: 'hint' }, `資料來源：${catalog.source}`),
    ),
  );
}

function deckItem(deck, progress) {
  return h('button', {
    class: 'deckitem' + (deck.id === deckId ? ' deckitem--on' : ''),
    onclick: () => loadDeck(deck.id).catch(showError),
  },
    h('span', { class: 'deckitem__label' }, deck.label),
    h('span', { class: 'deckitem__count' }, `${deck.count.toLocaleString()} 字`),
    progress && progressBar(progress.mastered, progress.learning, progress.count),
    progress && h('span', { class: 'deckitem__note' }, progressText(progress)),
    deck.note && h('span', { class: 'deckitem__note' }, deck.note),
  );
}

/**
 * 一級的進度講成一句話。
 *
 * 刻意**不寫百分比**：一級有一兩千個字，練了 20 張算出來是「0%」——
 * 明明有進度卻顯示 0，比不顯示更糟。實際的張數才看得出自己在哪裡。
 */
function progressText(p) {
  if (p.seen === 0) return '還沒開始';
  return [
    `已熟練 ${p.mastered}`,
    `學習中 ${p.learning}`,
    p.due ? `待複習 ${p.due}` : null,
    `沒學過 ${p.fresh.toLocaleString()}`,
  ].filter(Boolean).join('・');
}

function showError(err) {
  clear(root);
  append(root, h('div', { class: 'banner banner--error' }, err.message));
}

// ─── 卡片 ────────────────────────────────────────────────────────────────
function cardFace(card) {
  const state = getCardState(card);

  return h('div', { class: 'card' },
    h('div', { class: 'card__meta' },
      card.category && h('span', { class: 'chip' }, categoryLabel(card.category)),
      h('span', { class: 'chip chip--muted' }, difficultyLabel(card.difficulty)),
      // Collins 星等：柯林斯詞典的常用度（5 星最常用）。比 easy/medium/hard
      // 有資訊 —— 那一欄是從詞頻換算的，星等是詞典編輯標的。
      card.collins > 0 && h('span', { class: 'chip chip--muted' }, '★'.repeat(card.collins)),
      card.oxford && h('span', { class: 'chip chip--muted' }, 'Oxford 3000'),
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
