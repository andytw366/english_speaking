// 前端偏好設定，存在 localStorage。
// API 金鑰不在這裡 —— 那些存在伺服器的 .env，前端只透過 /api/settings 讀寫。

const KEY = 'speaking-coach:settings';

export const DEFAULTS = {
  ttsVoice: '',          // 空字串 = 自動挑選
  ttsRate: 0.9,
  vocabDailyGoal: 20,    // 單字卡每天練幾個字，0 = 不限（見下面的搬家）
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
  shadowingGoal: 5,      // 跟讀：每日目標句數
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
 * 舊設定搬到新設定。
 *
 * `sessionLimit`（單字卡一輪最多幾張）換成 `vocabDailyGoal`（一天練幾個字）——
 * 「一輪」關掉重開就再來一輪，數字管不住任何東西；「一天」才是使用者真正在意的量。
 * 設過自訂值的人要把那個數字帶過來，不然改版之後他調的 50 會無聲變回 20。
 *
 * 舊鍵留在 localStorage 裡不刪：萬一要退版，資料還在。
 */
function migrate(settings) {
  if (settings.vocabDailyGoal === undefined && typeof settings.sessionLimit === 'number') {
    return { ...settings, vocabDailyGoal: settings.sessionLimit };
  }
  return settings;
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
