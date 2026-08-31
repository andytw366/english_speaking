// 顯示用的字串與分級規則。
//
// 抽出來的理由：這些常數原本散在 app.js 裡，但紀錄清單、趨勢圖、句子卡片
// 三個地方都要用同一組 —— 分數門檻（60 / 80）尤其不能各自定義，
// 不然趨勢圖的格線會跟紀錄上的顏色對不起來。

export const CATEGORY_LABEL = {
  daily: '日常對話',
  food: '餐飲',
  shopping: '購物',
  travel: '旅遊',
  health: '健康',
  school: '學習',
  work: '職場',
  interview: '面試',
};
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

/**
 * 「上次練是多久以前」。
 *
 * 用相對時間而不是絕對時間，是因為這個字串要跟間隔重複的安排對得起來 ——
 * 使用者要判斷的是「這句擱著多久了」，不是「那天是幾月幾號」。
 *
 * @param {string} iso
 * @param {number} [now] 注入現在時間，測試用
 * @returns {string} 無效時間回空字串
 */
export function relativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso ?? '');
  if (Number.isNaN(then)) return '';

  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 0) return '剛剛'; // 時鐘被調過；講「-3 分鐘前」只會更奇怪
  if (minutes < 60) return minutes < 2 ? '剛剛' : `${minutes} 分鐘前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;

  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? '昨天' : `${days} 天前`;

  const months = Math.floor(days / 30);
  return months < 12 ? `${months} 個月前` : `${Math.floor(months / 12)} 年前`;
}

/**
 * 發音問題類型的中文標籤（對應 server/gemini.js 的 ISSUE_CODES）。
 *
 * 有標籤才看得出「又是 th」—— 同一類錯誤重複出現，比單看某一個字唸錯更有意義。
 * 後端已經把沒見過的代碼歸成 other，這裡再兜一次底，避免代碼原文漏到畫面上。
 */
export const ISSUE_LABEL = {
  th: 'th 音',
  r_l: 'r / l',
  v_w: 'v / w',
  final_consonant: '字尾子音',
  plural_ed: '字尾 -s / -ed',
  vowel_length: '長短母音',
  n_ng: 'n / ng',
  extra_vowel: '多了母音',
  stress: '重音',
  linking: '連音',
  other: '發音',
};

export function issueLabel(code) {
  return ISSUE_LABEL[code] ?? ISSUE_LABEL.other;
}
