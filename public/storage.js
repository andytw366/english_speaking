// 階段 5：localStorage 的練習紀錄與偏好設定。
//
// localStorage 不是永遠都能用 —— Safari 無痕模式、瀏覽器隱私設定、
// 企業政策都可能讓 getItem/setItem 直接丟例外（不是回 null，是 throw）。
// 這裡一律包在 try/catch 裡，失敗就退化成「這次不記錄」，不讓 App 整個掛掉。

const HISTORY_KEY = 'speaking-coach.history.v1';
const PREFS_KEY = 'speaking-coach.prefs.v1';

/** 保留的紀錄筆數上限。舊的會被丟掉。 */
const MAX_RECORDS = 200;

let available = null;

/** 探測 localStorage 到底能不能寫。結果快取起來，不用每次都試。 */
export function storageAvailable() {
  if (available !== null) return available;
  try {
    const probe = '__speaking_coach_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    available = true;
  } catch {
    available = false;
  }
  return available;
}

function readJson(key, fallback) {
  if (!storageAvailable()) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    // 資料壞掉（手動改過、或舊版格式）就當作沒有，不要讓整頁載入失敗
    console.warn(`[storage] ${key} 讀取失敗，忽略既有資料：`, err);
    return fallback;
  }
}

function writeJson(key, value) {
  if (!storageAvailable()) return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn(`[storage] ${key} 寫入失敗：`, err);
    return false;
  }
}

// ─── 練習紀錄 ────────────────────────────────────────────────────────────

/** @returns {Array<object>} 由新到舊 */
export function loadHistory() {
  const data = readJson(HISTORY_KEY, []);
  if (!Array.isArray(data)) return [];
  return data.filter((r) => r && typeof r === 'object');
}

/**
 * 新增一筆紀錄，回傳更新後的完整清單。
 * 寫入失敗（例如配額滿）時會先砍掉一半舊資料再試一次。
 */
export function addRecord(record) {
  const history = [record, ...loadHistory()].slice(0, MAX_RECORDS);

  if (!writeJson(HISTORY_KEY, history)) {
    const trimmed = history.slice(0, Math.floor(history.length / 2));
    if (writeJson(HISTORY_KEY, trimmed)) {
      console.warn('[storage] 空間不足，已丟棄較舊的一半紀錄');
      return trimmed;
    }
    // 還是寫不進去：回傳記憶體中的清單，至少這次的畫面是對的
    return history;
  }
  return history;
}

export function clearHistory() {
  if (!storageAvailable()) return;
  try {
    window.localStorage.removeItem(HISTORY_KEY);
  } catch (err) {
    console.warn('[storage] 清除紀錄失敗：', err);
  }
}

/** 練習次數與平均分。只計入有分數的紀錄。 */
export function summarise(history) {
  const scored = history.filter((r) => typeof r.score === 'number');
  const total = scored.reduce((sum, r) => sum + r.score, 0);
  return {
    count: history.length,
    scoredCount: scored.length,
    average: scored.length ? Math.round(total / scored.length) : null,
    best: scored.length ? Math.max(...scored.map((r) => r.score)) : null,
  };
}

// ─── 偏好設定（選的 model、篩選條件）─────────────────────────────────────

export function loadPrefs() {
  const prefs = readJson(PREFS_KEY, {});
  return prefs && typeof prefs === 'object' ? prefs : {};
}

export function savePrefs(patch) {
  writeJson(PREFS_KEY, { ...loadPrefs(), ...patch });
}
