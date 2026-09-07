// 這台裝置的 id。
//
// 為什麼需要它：每日計數表改成「每台裝置各記各的」（G-Counter）——
// 手機練 3 個、桌機練 2 個，同一天的真相是 5，而
//   取 max → 3（少算）
//   相加   → 5，但重複同步一次就變 10（不冪等）
// 只有「每台一格、讀時加總、合併時逐格取 max」同時不少算也不膨脹。
// 那個「一格」就是這裡的 id。
//
// ⚠️ **絕對不能進備份檔（`BACKUP_KEYS`）。** 還原到另一台裝置時要是同一個 id，
// 兩台從此互相覆蓋對方的格子 —— 而症狀是「明明兩台都練了，數字卻只有一台的」，
// 沒有任何錯誤訊息。所以它自己一個鍵，而且不在那份白名單裡。

const KEY = 'speaking-coach:deviceId';

/** 舊資料搬進來的保留格。**固定的名字，不是任何一台裝置。** */
export const LEGACY_SLOT = 'legacy';

let cached = null;

/**
 * 這台裝置的 id。第一次呼叫時產生並存起來。
 *
 * 私密瀏覽（存不進去）時每次載入都會拿到一個新的 —— 那沒問題：
 * 新的 id 就是新的一格，加總起來還是對的，只是那一格下次不會再被更新。
 */
export function deviceId() {
  if (cached) return cached;

  try {
    const saved = localStorage.getItem(KEY);
    if (saved && /^[\w-]{8,64}$/.test(saved)) {
      cached = saved;
      return cached;
    }
  } catch {
    // 私密瀏覽：讀不到就產一個新的
  }

  cached = newId();
  try {
    localStorage.setItem(KEY, cached);
  } catch {
    // 存不進去也照樣用，只是下次載入會換一個
  }
  return cached;
}

function newId() {
  // randomUUID 要 secure context；區網 IP 上沒有，所以要有退路
  try {
    if (crypto?.randomUUID) return `dev-${crypto.randomUUID().slice(0, 12)}`;
  } catch { /* 往下走 */ }
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return `dev-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  } catch { /* 往下走 */ }
  return `dev-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 測試用：換一個 id（模擬「另一台裝置」）。 */
export function _setDeviceId(id) {
  cached = id;
  try {
    localStorage.setItem(KEY, id);
  } catch { /* 忽略 */ }
}
