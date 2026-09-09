// 前端偏好設定，存在 localStorage。
// API 金鑰不在這裡 —— 那些存在伺服器的 .env，前端只透過 /api/settings 讀寫。

const KEY = 'speaking-coach:settings';

export const DEFAULTS = {
  ttsVoice: '',          // 空字串 = 自動挑選
  ttsRate: 0.9,
  // 每個模式每天練幾個。0 = 不設目標。單位各自不同（字／題／句），見 lib/labels.js
  dailyGoals: {
    vocabulary: 20,
    listening: 2,   // 單位是「組」不是「題」，一組要聽完再答 2～6 題
    translation: 10,
    dialogue: 6,
    shadowing: 5,
  },
  // 單字卡要練哪些題型（可複選，混合出題）。空陣列會退回翻卡，見 lib/quiz.js
  vocabQuizTypes: ['zh2en', 'en2zh'],
  categories: [],        // 空陣列 = 全部
  difficulties: [],      // 空陣列 = 全部
  translationType: 'all',// all | cloze | sentence
  autoPlayListening: false,
  vocabDeck: 'curated',  // 目前選的單字牌組
  geminiModel: '',       // 空字串 = 用後端的預設值
  // 三個會呼叫模型的功能，**用同一組選項**：自動 / 手動 / 關。
  //
  // 為什麼三個都要有「手動」：這些是整個 App 唯一會花錢、也唯一要等的東西。
  // 只給「開／關」的話，想要「今天先不花錢、但這一句我真的想知道」就沒有辦法表達
  // —— 而那正是最常見的狀態。手動模式下畫面上留一個按鈕，按了才呼叫。
  //
  // 為什麼三個各自一個而不是一個總開關：花錢的速度差一個數量級
  // （中翻英一題一次、情境對話一段七次、跟讀一句一次），
  // 很可能只想讓其中一個自動。
  ai: {
    narration: 'auto',    // 跟讀的中文講評
    dialogue: 'auto',     // 情境對話的 AI 修正
    translation: 'auto',  // 中翻英的 AI 修正
  },
  autoPlayListening: false, // 聽力：換一題就自動播放
  shadowingWeighted: true,  // 跟讀：依成績與間隔加權抽句
};

/** 會呼叫模型的功能。**設定頁與各模式共用這一份**，順序就是畫面上的順序。 */
export const AI_FEATURES = [
  {
    id: 'narration',
    label: '跟讀的中文講評',
    mode: 'shadowing',
    auto: '送出錄音時一起要 —— 分數之後會多等幾秒。',
    manual: '先看分數，想要建議時按「要中文講評」。',
    off: '一律用本地摘要（照樣指得出最弱的面向與唸不好的字）。',
  },
  {
    id: 'dialogue',
    label: '情境對話的 AI 修正',
    mode: 'dialogue',
    auto: '每按一次「對答案」就讓模型看你寫的那一句。',
    manual: '結果卡上留一顆按鈕（或按 A），按了才呼叫。',
    off: '只用本地批改與教材的參考說法。',
  },
  {
    id: 'translation',
    label: '中翻英的 AI 修正',
    mode: 'translation',
    auto: '每按一次「對答案」就讓模型看你寫的那一句。',
    manual: '結果卡上留一顆按鈕（或按 A），按了才呼叫。',
    off: '只用本地批改與教材的參考答案。',
  },
];

/** 三種模式。**順序有意義**（花最多錢 → 完全不花），畫面上照這個順序排。 */
export const AI_MODES = [
  ['auto', '自動'],
  ['manual', '手動'],
  ['off', '關'],
];

/**
 * 某個 AI 功能現在是自動、手動、還是關。
 *
 * 認不得的值當成自動 —— 手改過 localStorage、或退版之後留下舊值時，
 * 「功能整個消失」比「多花了幾次呼叫」難查得多。
 */
export function aiMode(feature) {
  const value = getSettings().ai?.[feature];
  return AI_MODES.some(([id]) => id === value) ? value : 'auto';
}

export function setAiMode(feature, mode) {
  return updateSettings({ ai: { ...getSettings().ai, [feature]: mode } });
}

let cache = null;

export function getSettings() {
  if (cache) return cache;
  try {
    // migrate() 收的是**存起來的原始資料**，不是併好 DEFAULTS 的版本 ——
    // 併好之後就分不出「使用者設過 2」與「這是預設值 2」，而搬家規則常常
    // 需要知道這件事（聽力的目標換單位就是）。DEFAULTS 在 migrate() 裡面併。
    cache = migrate(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

/**
 * 舊設定搬到新設定。**設過的數字一定要帶過來** ——
 * 改版之後使用者調的 50 無聲變回 20，是最容易讓人不再相信設定頁的方式。
 *
 * 兩代：
 *   `sessionLimit`（單字卡一輪最多幾張）→ `vocabDailyGoal`（一天練幾個字）。
 *     「一輪」關掉重開就再來一輪，數字管不住任何東西；「一天」才是真正在意的量。
 *   `vocabDailyGoal` / `shadowingGoal` → `dailyGoals`（六個模式一起管）。
 *   聽力的目標從「題」變成「組」（見下面 `listeningGoalInSets`）。
 *
 * 舊鍵留在 localStorage 裡不刪：萬一要退版，資料還在。
 */
function migrate(stored) {
  // `ai` 跟 `dailyGoals` 一樣是巢狀的，而展開是淺層的 —— 只設過其中一個功能時，
  // 另外兩個會變成 undefined（然後 `aiMode()` 回預設值，但畫面上會看不出選了哪個）
  const settings = { ...DEFAULTS, ...stored, ai: { ...DEFAULTS.ai, ...(stored.ai ?? {}) } };
  // **在分支之前算好**：下面聽力那一段有一個提早 return，
  // 而只在最後一個 return 併 ai 的話，還沒搬過聽力目標的人（也就是所有舊資料）
  // 三個 AI 開關就會通通吃預設值 —— 「我明明關掉了卻又自動送出去」
  const ai = migrateAi(stored, settings.ai);
  const legacyVocab = settings.vocabDailyGoal ?? settings.sessionLimit;
  const goals = { ...DEFAULTS.dailyGoals, ...(stored.dailyGoals ?? {}) };

  if (stored.dailyGoals?.vocabulary === undefined && typeof legacyVocab === 'number') {
    goals.vocabulary = legacyVocab;
  }
  if (stored.dailyGoals?.shadowing === undefined && typeof settings.shadowingGoal === 'number') {
    goals.shadowing = settings.shadowingGoal;
  }

  // 聽力的今天進度從「題」改成「組」之後，存著的目標數字**意思變了** ——
  // 原本設 6（題，大約兩組）會突然變成 6 組，怎麼練都達不到，
  // 而畫面上不會有任何徵兆說「這個數字換單位了」。
  //
  // 一組平均 2.8 題（226 題 / 81 組），所以除以 3 再取整。
  // 這裡**需要**一個旗標而不是看數字大小：6 在兩種單位下都是合法的值，
  // 光看數字分不出它有沒有換算過，跑第二次就會把 2 再除成 1。
  if (!stored.listeningGoalInSets) {
    // 只換算**使用者自己設過**的值。看併好 DEFAULTS 的版本會連預設值一起除，
    // 全新安裝的目標就會從 2 組變成 1 組。
    const old = stored.dailyGoals?.listening;
    if (typeof old === 'number' && old > 0) {
      goals.listening = Math.max(1, Math.round(old / 3));
    }
    return { ...settings, ai, dailyGoals: goals, listeningGoalInSets: true };
  }

  return { ...settings, ai, dailyGoals: goals };
}

/**
 * 三個 AI 功能的開關從各自的布林值搬到一個 `ai` 物件（自動／手動／關）。
 *
 * **搬的是「使用者真的設過」的值**，所以看的是 `stored` 而不是併好預設值的版本
 * —— 看併好的版本會把預設值也當成使用者的選擇，而那兩件事在這裡剛好相反：
 * `geminiNarration` 沒設過是「要」，設過 false 才是「不要」。
 *
 * 對應關係刻意不對稱：
 *   `geminiNarration: false`  → `off`（那時候沒有「手動」，關掉就是只看本地摘要）
 *   `dialogueAiReview: false` → `manual`（那時候關掉之後按鈕還在，就是手動）
 */
function migrateAi(stored, current) {
  const ai = { ...current };
  if (stored.ai?.narration === undefined && stored.geminiNarration === false) {
    ai.narration = 'off';
  }
  if (stored.ai?.dialogue === undefined && stored.dialogueAiReview === false) {
    ai.dialogue = 'manual';
  }
  if (stored.ai?.translation === undefined && stored.translationAiReview === false) {
    ai.translation = 'manual';
  }
  return ai;
}

/** 某個模式的每日目標。0（或沒設）代表不設目標。 */
export function goalOf(mode) {
  const n = Number(getSettings().dailyGoals?.[mode]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 改某個模式的每日目標。 */
export function setGoal(mode, value) {
  const n = Math.max(0, Math.min(500, Number(value) || 0));
  return updateSettings({ dailyGoals: { ...getSettings().dailyGoals, [mode]: n } });
}

export function updateSettings(patch) {
  // updatedAt：跨裝置合併時，設定是「整包取比較新的那一邊」——
  // 逐欄位合併會產生一個一半舊一半新、而使用者從來沒有選過的組合。
  // 跟 srs 的 `at` 一樣，階段 A 就先寫著（見 docs/accounts-and-sync.md）
  const next = { ...getSettings(), ...patch, updatedAt: Date.now() };
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 私密瀏覽：設定不會保留，但當次仍然生效
  }
  window.dispatchEvent(new CustomEvent('settings-changed', { detail: next }));
  return next;
}

export function resetSettings() {
  cache = { ...DEFAULTS };
  try { localStorage.removeItem(KEY); } catch { /* 忽略 */ }
  window.dispatchEvent(new CustomEvent('settings-changed', { detail: cache }));
}

/** 依設定過濾內容（分類與難度）。空的篩選代表不過濾。 */
export function filterBySettings(items) {
  const { categories, difficulties } = getSettings();
  return items.filter((x) =>
    (categories.length === 0 || categories.includes(x.category)) &&
    (difficulties.length === 0 || difficulties.includes(x.difficulty))
  );
}
