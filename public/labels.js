// 顯示用的字串與分級規則。
//
// 抽出來的理由：這些常數原本散在 app.js 裡，但紀錄清單、趨勢圖、句子卡片
// 三個地方都要用同一組 —— 分數門檻（60 / 80）尤其不能各自定義，
// 不然趨勢圖的格線會跟紀錄上的顏色對不起來。

export const CATEGORY_LABEL = { daily: '日常對話', interview: '面試', travel: '旅遊' };
export const DIFFICULTY_LABEL = { easy: '簡單', medium: '中等', hard: '困難' };

/** 難度下拉選單的排序。直接用 Object.keys 會變成 sentences.json 的出現順序。 */
export const DIFFICULTY_ORDER = ['easy', 'medium', 'hard'];

export function categoryLabel(value) {
  return CATEGORY_LABEL[value] ?? value ?? '';
}

export function difficultyLabel(value) {
  return DIFFICULTY_LABEL[value] ?? value ?? '';
}

/**
 * 把 ISO 時間字串轉成「今天 14:30」／「8/30 14:30」。
 * 無效的時間回空字串 —— 紀錄是使用者可以手動改壞的 localStorage，不能假設它一定合法。
 */
export function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = new Date().toDateString() === date.toDateString();
  const time = date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `今天 ${time}`;
  return `${date.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })} ${time}`;
}

/** 分數的 CSS class。門檻 60 / 80 同時是趨勢圖的格線位置。 */
export function scoreClass(score) {
  if (score >= 80) return 'score--good';
  if (score >= 60) return 'score--ok';
  return 'score--low';
}
