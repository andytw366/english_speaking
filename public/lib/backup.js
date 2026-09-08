// 學習資料的備份檔：組出來、讀回去、以及讀回去之前的把關。
//
// **為什麼這件事值得做在加功能之前**：`localStorage` 裡現在有 10,000 字的複習進度、
// 每天練了幾個字的計數表、跟讀的練習紀錄與連續天數 —— 而首頁自己就寫著
// 「換瀏覽器或清除瀏覽資料就會消失」。那些東西**重建不出來**：句庫可以重跑腳本，
// 「你哪一天練了什麼、哪個字進到第幾盒」不行。
//
// 這個模組是純函式（不碰 localStorage、不碰 DOM），所以 `backup.test.js` 測得到
// 「壞掉的檔案不會被吃進去」這件事 —— 而那正是還原最危險的地方：
// 匯入一份不完整的檔案，等於把現有的進度覆蓋成半殘的資料，而且沒有第二次機會。

/** 備份檔的格式版本。**改變資料形狀時才 +1**，加欄位不用。 */
export const BACKUP_VERSION = 1;

/** 這個字串是用來認「這是不是這個 App 的備份檔」，不要改。 */
export const BACKUP_APP = 'speaking-coach';

/**
 * 備份會帶走哪些 localStorage 的鍵（不含 `speaking-coach:` 前綴）。
 *
 * **這份清單同時是白名單**：還原時只寫得回這幾個鍵，所以就算有人手改備份檔
 * 塞進別的鍵，也進不了 localStorage。新增要備份的資料時記得加進來 ——
 * 漏加的症狀是「還原之後某一種進度不見了」，而且不會有任何錯誤訊息。
 */
export const BACKUP_KEYS = [
  'srs', 'srsVersion', 'activity', 'vocabDays', 'history', 'settings', 'reviews',
];

/**
 * 把目前的狀態組成一份備份。
 *
 * @param {Record<string, unknown>} state `BACKUP_KEYS` 的鍵 → 值
 * @param {number} now 匯出時間（測試要注入）
 */
export function buildBackup(state, now = Date.now()) {
  const data = {};
  for (const key of BACKUP_KEYS) {
    if (state?.[key] !== undefined) data[key] = state[key];
  }
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: new Date(now).toISOString(),
    data,
  };
}

/**
 * 讀一份備份檔。壞掉的一律丟例外，訊息直接給使用者看。
 *
 * 這裡的每一條檢查都對應一種「還原之後才發現不對」的情況：
 *   - 不是 JSON            → 選錯檔案（例如選到 .txt）
 *   - 沒有 app 標記        → 別的 App 的匯出檔
 *   - 版本比程式新         → 用新版存的檔在舊版還原，形狀可能對不上
 *   - data 不是物件        → 檔案被截斷或編輯壞了
 *   - 一個認得的鍵都沒有   → 空檔案，還原下去等於把進度清空
 *
 * @returns {{version: number, exportedAt: string, data: Record<string, unknown>}}
 */
export function parseBackup(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('這個檔案不是有效的 JSON，請確認選到的是這個 App 匯出的備份檔。');
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('備份檔的格式不對（最外層應該是一個物件）。');
  }
  if (raw.app !== BACKUP_APP) {
    throw new Error('這不是「英語學習練習」的備份檔（缺少 app 標記）。');
  }

  const version = Number(raw.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('備份檔沒有版本號，無法確認格式。');
  }
  if (version > BACKUP_VERSION) {
    throw new Error(
      `這份備份是較新的版本（第 ${version} 版），這個 App 只讀得懂第 ${BACKUP_VERSION} 版。` +
      '請更新 App 之後再還原。'
    );
  }

  const data = raw.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('備份檔裡沒有 data，可能是檔案不完整。');
  }

  // 只留白名單裡的鍵：手改過的備份檔塞不進別的東西
  const clean = {};
  for (const key of BACKUP_KEYS) {
    if (data[key] !== undefined) clean[key] = data[key];
  }
  if (Object.keys(clean).length === 0) {
    throw new Error('備份檔裡沒有任何看得懂的學習資料，還原會把現有進度清空，所以擋下來了。');
  }

  return { version, exportedAt: String(raw.exportedAt ?? ''), data: clean };
}

/**
 * 一份備份裡有什麼。還原**之前**要讓人看到這個 ——
 * 「確定要覆蓋嗎？」沒有附上「用什麼覆蓋」的話，那個確認等於沒有意義。
 */
export function backupSummary(data) {
  const count = (value) => (value && typeof value === 'object' ? Object.keys(value).length : 0);

  // 每日紀錄有兩種來源：新的 activity（六個模式各一張計數表）與
  // 舊版的 vocabDays（只有單字卡）。舊備份還讀得回去，所以兩種都算。
  const perMode = Object.values(data?.activity ?? {}).filter(
    (days) => days && typeof days === 'object' && !Array.isArray(days)
  );
  const legacy = data?.vocabDays && typeof data.vocabDays === 'object' ? [data.vocabDays] : [];
  const tables = perMode.length ? perMode : legacy;

  const allDays = new Set();
  let items = 0;
  for (const days of tables) {
    for (const [key, value] of Object.entries(days)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) continue;
      allDays.add(key);
      items += Math.floor(n);
    }
  }

  return {
    words: count(data?.srs),
    days: allDays.size,
    items,
    attempts: Array.isArray(data?.history) ? data.history.length : 0,
    reviews: count(data?.reviews),
    hasSettings: Boolean(data?.settings),
  };
}

/** 給使用者看的一句話摘要。 */
export function summaryText(summary) {
  const parts = [
    `單字進度 ${summary.words} 個字`,
    `每日紀錄 ${summary.days} 天`,
    `跟讀紀錄 ${summary.attempts} 筆`,
  ];
  // 沒有 AI 修正紀錄時不寫這一行 —— 沒開這個功能的人看到「0 筆」只會困惑
  if (summary.reviews) parts.push(`AI 修正 ${summary.reviews} 筆`);
  if (summary.hasSettings) parts.push('偏好設定');
  return parts.join('・');
}

/**
 * 備份檔名。
 *
 * 兩件事是刻意的：
 *   - **日期用本地時間**，不是 UTC —— 使用者說的「今天」是他自己的今天。
 *   - **檔名全 ASCII**。原本寫成「speaking-coach-備份-20260905.json」，
 *     Chromium 直接忽略整個 `download` 屬性、把檔案存成 `download`
 *     （用 Playwright 抓 `suggestedFilename()` 才發現）。跨平台的檔案系統
 *     對非 ASCII 檔名的處理也各有各的脾氣，不值得為了好看賭這個。
 */
export function backupFilename(now = Date.now()) {
  const d = new Date(now);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `speaking-coach-backup-${d.getFullYear()}${mm}${dd}.json`;
}
