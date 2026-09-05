// 前端偏好設定，存在 localStorage。
// API 金鑰不在這裡 —— 那些存在伺服器的 .env，前端只透過 /api/settings 讀寫。

const KEY = 'speaking-coach:settings';

export const DEFAULTS = {
  ttsVoice: '',          // 空字串 = 自動挑選
  ttsRate: 0.9,
  // 每個模式每天練幾個。0 = 不設目標。單位各自不同（字／題／句），見 lib/labels.js
  dailyGoals: {
    vocabulary: 20,
    listening: 6,
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
  shadowingWeighted: true, // 跟讀：依成績與間隔加權抽句
};

let cache = null;

export function getSettings() {
  if (cache) return cache;
  try {
    cache = migrate({ ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') });
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
 *
 * 舊鍵留在 localStorage 裡不刪：萬一要退版，資料還在。
 */
function migrate(settings) {
  const legacyVocab = settings.vocabDailyGoal ?? settings.sessionLimit;
  const goals = { ...DEFAULTS.dailyGoals, ...(settings.dailyGoals ?? {}) };

  if (settings.dailyGoals?.vocabulary === undefined && typeof legacyVocab === 'number') {
    goals.vocabulary = legacyVocab;
  }
  if (settings.dailyGoals?.shadowing === undefined && typeof settings.shadowingGoal === 'number') {
    goals.shadowing = settings.shadowingGoal;
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
  const next = { ...getSettings(), ...patch };
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
