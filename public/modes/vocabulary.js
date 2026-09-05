import { h, clear, append } from '../lib/dom.js';
import { categoryLabel, difficultyLabel } from '../lib/labels.js';
import { speak, isSupported as ttsSupported } from '../lib/tts.js';
import {
  buildQueue, recordAnswer, srsSummary, getCardState, resetSrs,
  getSrsState, tierProgress,
  getVocabDays, recordVocabAnswer, vocabDayCount, vocabActiveDays,
} from '../lib/storage.js';
import { dayKey, streakFromDays } from '../lib/practice.js';
import { pickType, buildQuestion } from '../lib/quiz.js';
import { renderTodayCard } from '../lib/today-card.js';
import { filterBySettings, getSettings, updateSettings } from '../lib/settings.js';

export const meta = { id: 'vocabulary', label: '單字卡', icon: '🗂️' };

// 熟練到這個比例（或沒學過的剩不到 10%）就建議往上一級。
// 不自動跳級 —— 使用者自己選難度，這裡只提醒。
const ADVANCE_MASTERED = 0.8;
const ADVANCE_FRESH_LEFT = 0.1;

/** 今天的份練完之後，「再多練一點」一次加幾張。 */
const EXTRA_BATCH = 10;

let catalog = null;      // index.json
let tierMap = null;      // tier-map.json，各級進度用（載不到就不顯示總覽）
let deckId = null;       // 目前的牌組
let cards = [];
let queue = [];
let index = 0;
let revealed = false;
let picking = false;     // 是否停在選難度的畫面
let showBands = false;   // 詞頻級距預設收起來 —— 分級才是主要的選法
let extra = 0;           // 今天目標達成後又自己多要的張數
let currentType = 'flip';// 這張卡出哪一種題型（設定裡可以複選，一張一抽）
let question = null;     // 選擇題的題目。翻卡時是 null
let picked = null;       // 這一題選了哪個選項：{ id, correct }
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
  // 干擾項是從目前這一級抽的，所以換級一定要重新出題
  startSession();
}

/**
 * 這一級可以抽的卡。
 *
 * 抽多少由 `dailyState()` 的每日目標決定；順序由 `buildQueue()` 決定
 * （到期要複習的優先，再補沒學過的）。
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

/**
 * 今天的份還剩幾張。
 *
 * 每日目標（設定裡的「單字卡每天練幾個字」）是**跨牌組、跨開關 App** 算的 ——
 * 計數表記的是日期而不是場次，所以關掉重開、或者中途換一級，今天練過的數字
 * 都還在。這正是它跟舊的「一輪最多幾張」的差別：那個數字關掉重開就重來，
 * 等於沒有限制任何東西。
 */
function dailyState(now = Date.now()) {
  const goal = getSettings().vocabDailyGoal;
  const days = getVocabDays();
  const done = vocabDayCount(days, dayKey(new Date(now)));
  return {
    goal,
    done,
    streak: streakFromDays(vocabActiveDays(days), now),
    // 目標設 0 = 不限，這一級的字全部排進來
    remaining: goal > 0 ? Math.max(0, goal + extra - done) : Infinity,
  };
}

function startSession() {
  const { remaining } = dailyState();
  queue = buildQueue(currentPool());
  if (Number.isFinite(remaining)) queue = queue.slice(0, remaining);
  index = 0;
  prepareCard();
  render();
}

/**
 * 決定這張卡怎麼問。
 *
 * **一定要在換卡的時候做一次、存起來** —— 放在 render() 裡的話，每次重畫
 * （選了選項、按了播放）都會重抽題型與干擾項，選項會在眼前跳掉。
 */
function prepareCard() {
  question = null;
  picked = null;
  revealed = false;

  const card = queue[index];
  if (!card) return;

  currentType = pickType(getSettings().vocabQuizTypes);
  if (currentType === 'flip') return;

  question = buildQuestion(card, currentPool(), { direction: currentType });
  // 湊不到足夠的干擾項（例如精選那 40 張裡同義的太多）就退回翻卡，
  // 不要出一題只有兩個選項的題目
  if (!question) currentType = 'flip';
}

function render() {
  if (!root) return;
  clear(root);

  if (picking) return renderPicker();

  const deck = deckOf(deckId);
  const summary = srsSummary(currentPool());
  const daily = dailyState();

  append(root, deckCard(deck, summary), todayCard(daily));

  // 今天的份練完了。**不擋著不讓練** —— 目標是拿來知道自己完成了，不是拿來鎖門的。
  if (daily.remaining <= 0) {
    append(root,
      h('div', { class: 'card empty' },
        h('p', { class: 'empty__title' }, `今天的 ${daily.goal} 個字練完了 🎉`),
        h('p', { class: 'hint' },
          daily.streak > 1
            ? `連續 ${daily.streak} 天。明天到期要複習的字會自動排在最前面。`
            : '明天到期要複習的字會自動排在最前面。'),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn btn--primary',
            onclick: () => { extra += EXTRA_BATCH; startSession(); },
          }, `再多練 ${EXTRA_BATCH} 個`),
          h('button', { class: 'btn btn--ghost', onclick: () => { picking = true; render(); } }, '換難度'),
        ),
      ),
    );
    return;
  }

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
    // 今天的份還沒滿，但這一級能抽的字抽完了（到期的都複習過、新字也發完）
    append(root,
      h('div', { class: 'card empty' },
        h('p', { class: 'empty__title' }, `這一級今天能練的都練完了（${queue.length} 張）`),
        h('p', { class: 'hint' }, '換一個難度就能繼續累積今天的進度。'),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn--primary', onclick: () => { picking = true; render(); } }, '換難度'),
          h('button', { class: 'btn btn--ghost', onclick: startSession }, '再看一次'),
        ),
      ),
    );
    return;
  }

  const card = queue[index];

  if (question) {
    append(root, questionCard(card, question));
    if (picked) {
      append(root,
        h('div', { class: 'card' },
          h('p', { class: 'card__title' }, picked.correct ? '答對了 ✅' : `答錯了 —— 正確答案是「${answerText(question)}」`),
          cardBack(card),
          h('div', { class: 'row' },
            h('button', { class: 'btn btn--primary', onclick: nextCard }, '下一題'),
            ttsSupported() && h('button', {
              class: 'btn btn--ghost',
              onclick: (e) => playWord(card, e.currentTarget),
            }, '🔊 唸這個字'),
          ),
          h('p', { class: 'hint' },
            picked.correct
              ? '這張卡進到下一個盒子，間隔會拉長。'
              : '答錯的卡會回到第 1 盒，明天再出現。'),
        ),
      );
    }
    return;
  }

  append(root, cardFace(card));

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

// ─── 選擇題 ──────────────────────────────────────────────────────────────
const answerText = (q) => q.options.find((o) => o.correct)?.text ?? '';

function questionCard(card, q) {
  const state = getCardState(card);
  const zhToEn = q.direction === 'zh2en';

  return h('div', { class: 'card' },
    h('div', { class: 'card__meta' },
      h('span', { class: 'chip' }, zhToEn ? '看中文選英文' : '看英文選中文'),
      h('span', { class: 'chip chip--muted' }, `第 ${state.box} 盒`),
      h('span', { class: 'counter' }, `${index + 1} / ${queue.length}`),
    ),

    h('p', { class: zhToEn ? 'quiz__prompt quiz__prompt--zh' : 'quiz__prompt' }, q.prompt),
    q.promptHint && h('p', { class: 'quiz__hint' }, q.promptHint),

    // 題目就是那個英文字的時候才給發音 —— 中→英 先播就等於直接給答案
    !zhToEn && ttsSupported() && h('div', { class: 'row' },
      h('button', {
        class: 'btn btn--ghost',
        onclick: (e) => playWord(card, e.currentTarget),
      }, '🔊 唸這個字'),
    ),

    h('div', { class: 'quiz__options' },
      q.options.map((option) => h('button', {
        class: 'quiz__option' + optionState(option),
        // 答完之後不讓再點：分數已經記進去了，再點一次只會讓人以為可以改答案
        disabled: Boolean(picked),
        onclick: () => submitChoice(card, option),
      }, option.text))),
  );
}

function optionState(option) {
  if (!picked) return '';
  // 答錯時**同時**標出正確答案與自己選的那個 —— 只標「你錯了」的話，
  // 使用者還得自己去下面找正確答案是哪一個
  if (option.correct) return ' quiz__option--correct';
  if (option.id === picked.id) return ' quiz__option--wrong';
  return ' quiz__option--dim';
}

/**
 * 選了一個選項。
 *
 * 成績在這裡就記進去，不等按「下一題」—— 中途關掉 App 的話，
 * 那一題本來就答完了，不該因為沒按下一步而不算。
 */
function submitChoice(card, option) {
  if (picked) return;
  picked = { id: option.id, correct: option.correct };
  recordAnswer(card, option.correct);
  recordVocabAnswer(dayKey(new Date()));
  render();
}

function nextCard() {
  index++;
  // 這一批發完就重算：今天的份可能剛好滿了，該換成「今天練完了」那張卡
  if (index >= queue.length) return startSession();
  prepareCard();
  render();
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

    h('p', { class: 'hint' }, '抽卡順序：到期要複習的優先，再補沒學過的。'),

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

/** 今天練了幾個字、連續幾天。跟讀用的是同一張卡（`lib/today-card.js`）。 */
function todayCard(daily) {
  return renderTodayCard({
    done: daily.done,
    goal: daily.goal,
    streak: daily.streak,
    unit: '個字',
    label: '今天練的字',
    // 跟讀把每日目標的選單直接放在卡上；單字卡的目標放在「設定」，
    // 所以這裡只用一句話指路，不再放第二個能改同一個數字的地方。
    hint: daily.goal > 0 && daily.done < daily.goal
      ? `再 ${daily.goal - daily.done} 個字就達成今天的目標了。（每天幾個字在「設定」可以改）`
      : '',
  });
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

    revealed && cardBack(card),
  );
}

/** 卡片的背面。翻卡按「顯示答案」之後、以及選擇題答完之後都是這一份。 */
function cardBack(card) {
  return h('div', { class: 'vocab__back' },
    h('p', { class: 'vocab__meaning' }, card.meaning_zh),
    card.definition_en && h('p', { class: 'vocab__def' }, card.definition_en),
    card.example_en && h('p', { class: 'vocab__example' }, card.example_en),
    card.example_zh && h('p', { class: 'vocab__example-zh' }, card.example_zh),
    card.note_zh && h('p', { class: 'vocab__note' }, `💡 ${card.note_zh}`),
    card.tags?.length && h('p', { class: 'hint' }, `出現於：${card.tags.join('、')}`),
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

/** 翻卡的作答：使用者自己判斷記不記得。 */
function answer(card, wasCorrect) {
  recordAnswer(card, wasCorrect);
  // 記進「哪一天練了幾張」的計數表。答對答錯都算 —— 今天的份算的是練習量，
  // 不是正確率（正確率在 srs 的 box 裡）。
  recordVocabAnswer(dayKey(new Date()));
  nextCard();
}
