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
  geminiNarration: true, // 要不要等 Gemini 寫中文講評。關掉改用本地摘要，送出後快很多
  // 情境對話按「對答案」之後，要不要自動讓 AI 看你寫的那一句。
  // 關掉之後結果卡上仍有一個按鈕，按了才會呼叫 —— 這是唯一「打字就花錢」的地方，
  // 所以要留得住「我今天不想花這個錢」這個選擇
  dialogueAiReview: true,
  shadowingWeighted: true, // 跟讀：依成績與間隔加權抽句
};

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
  const settings = { ...DEFAULTS, ...stored };
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
    return { ...settings, dailyGoals: goals, listeningGoalInSets: true };
  }

  return { ...settings, dailyGoals: goals };
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
