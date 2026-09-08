// 兩份學習進度怎麼合成一份。**全部是純函式** —— 不碰 localStorage、不碰網路，
// 所以 `test/merge.test.js` 測得到，而伺服器也 import 得動（同一份，不寫兩遍）。
//
// 這是整個跨裝置同步裡最不能出錯的一段：**合併寫錯是靜悄悄的**，
// 使用者看到的只是「咦，昨天練的怎麼不見了」。所以每一條規則都要滿足兩個性質：
//
//   冪等   merge(merge(a, b), b) === merge(a, b)
//          不然「重試一次」就會讓數字膨脹
//   交換律 merge(a, b) === merge(b, a)
//          不然同步的先後順序會影響結果，兩台裝置會一直互相推翻
//
// 每個鍵的規則不一樣，理由寫在各自的函式上。設計的完整版在
// docs/accounts-and-sync.md。

/** 跟讀紀錄留幾筆。跟 `storage.js` 的 `HISTORY_LIMIT` 是同一個數字。 */
const HISTORY_LIMIT = 200;

/** 每個模式留幾天。跟 `storage.js` 的 `ACTIVITY_DAY_LIMIT` 是同一個數字。 */
const ACTIVITY_DAY_LIMIT = 400;

/** AI 修正留幾筆。跟 `storage.js` 的 `REVIEW_LIMIT` 是同一個數字。 */
const REVIEW_LIMIT = 200;

/**
 * 合併兩份進度。
 *
 * @param {object} a
 * @param {object} b
 * @returns {object} 只含兩邊真的有的鍵
 */
export function mergeState(a = {}, b = {}) {
  const left = a ?? {};
  const right = b ?? {};
  const out = {};

  const put = (key, value) => {
    if (value !== undefined) out[key] = value;
  };

  put('srs', mergeSrs(left.srs, right.srs));
  put('srsVersion', mergeVersion(left.srsVersion, right.srsVersion));
  put('activity', mergeActivity(left.activity, right.activity));
  put('vocabDays', mergeDayNumbers(left.vocabDays, right.vocabDays));
  put('history', mergeHistory(left.history, right.history));
  put('settings', mergeSettings(left.settings, right.settings));
  put('reviews', mergeReviews(left.reviews, right.reviews));

  return out;
}

// ─── srs：每張卡取比較新的那一次 ─────────────────────────────────────────

/**
 * 複習進度。**每張卡整筆取比較新的那一次**，不是逐欄位合併。
 *
 * 為什麼看 `at` 而不是 `due`：`due` 判斷不了新舊 ——
 * box 4 一週前答的卡，`due` 比 box 1 今天剛答的還晚。
 *
 * 已知的限制（README 也寫了）：同一張卡在兩台裝置上、在兩次同步之間各答過一次時，
 * `seen` / `correct` 會少算一次。要完全正確得做向量時鐘，對「一個人、偶爾換裝置」
 * 不划算。而 `box` 與 `due` 是對的 —— 那才是決定下次何時複習的欄位。
 */
export function mergeSrs(a, b) {
  if (!isObject(a) && !isObject(b)) return undefined;
  const left = isObject(a) ? a : {};
  const right = isObject(b) ? b : {};

  const out = {};
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    out[key] = newerCard(left[key], right[key]);
  }
  return out;
}

function newerCard(x, y) {
  if (!isObject(x)) return y;
  if (!isObject(y)) return x;

  const ax = Number(x.at);
  const ay = Number(y.at);
  const hasX = Number.isFinite(ax);
  const hasY = Number.isFinite(ay);

  // 只有一邊有 at（另一邊是加這個欄位之前練的）→ 取有 at 的那一筆
  if (hasX && !hasY) return x;
  if (hasY && !hasX) return y;
  if (hasX && hasY && ax !== ay) return ax > ay ? x : y;

  // at 一樣或都沒有：退回看答過幾次
  const sx = Number(x.seen) || 0;
  const sy = Number(y.seen) || 0;
  if (sx !== sy) return sx > sy ? x : y;

  // 完全分不出來時**一定要有一條決定性的規則** ——
  // 隨便挑的話兩台裝置每次同步都會得到不同的結果，然後互相推翻
  return stable(x, y);
}

// ─── activity：每台裝置一格，逐格取 max ─────────────────────────────────

/**
 * 每日計數表。`{ mode: { day: { slot: n } } }`，**逐格取 max**。
 *
 * 這是整份規則裡最容易寫錯的一個：
 *   取 max（整天）→ 手機 3、桌機 2 得到 3，少算
 *   相加（整天）  → 得到 5，但重複同步一次就變 10，不冪等
 * 每台裝置只加自己那一格，所以逐格取 max 同時不少算也不膨脹 ——
 * 因為同一格只有一台裝置會動它，取 max 就等於取那台的最新值。
 */
export function mergeActivity(a, b) {
  if (!isObject(a) && !isObject(b)) return undefined;
  const left = isObject(a) ? a : {};
  const right = isObject(b) ? b : {};

  const out = {};
  for (const mode of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const days = mergeDaySlots(left[mode], right[mode]);
    if (days) out[mode] = trimDays(days, ACTIVITY_DAY_LIMIT);
  }
  return out;
}

function mergeDaySlots(a, b) {
  if (!isObject(a) && !isObject(b)) return null;
  const left = isObject(a) ? a : {};
  const right = isObject(b) ? b : {};

  const out = {};
  for (const day of new Set([...Object.keys(left), ...Object.keys(right)])) {
    out[day] = mergeSlots(left[day], right[day]);
  }
  return out;
}

/** 一天的格子。舊形狀（一個數字）先攤成 `legacy` 格再合，兩邊才比得起來。 */
function mergeSlots(a, b) {
  const left = asSlots(a);
  const right = asSlots(b);
  const out = {};
  for (const slot of new Set([...Object.keys(left), ...Object.keys(right)])) {
    out[slot] = Math.max(left[slot] ?? 0, right[slot] ?? 0);
  }
  return out;
}

function asSlots(value) {
  if (isObject(value)) {
    const out = {};
    for (const [slot, n] of Object.entries(value)) {
      const num = Number(n);
      if (Number.isFinite(num) && num > 0) out[slot] = Math.floor(num);
    }
    return out;
  }
  const n = Number(value);
  // `legacy` 是固定的保留格，不是任何一台裝置 ——
  // 搬進本機那一格的話，兩台各搬一次會讓同一段歷史加倍
  return Number.isFinite(n) && n > 0 ? { legacy: Math.floor(n) } : {};
}

/** 只留最近幾天。鍵是 YYYY-MM-DD，字串由大到小排就是由新到舊。 */
function trimDays(days, limit) {
  const keys = Object.keys(days).sort().reverse();
  if (keys.length <= limit) return days;
  return Object.fromEntries(keys.slice(0, limit).map((k) => [k, days[k]]));
}

// ─── vocabDays：只剩舊資料的鍵 ───────────────────────────────────────────

/**
 * `vocabDays` 是**上一代**的單字卡每日計數，現在只在第一次載入時被讀來生
 * `activity`（見 `storage.js` 的 `buildActivity()`），沒有人再寫它。
 *
 * 所以合併只求「不要弄丟」：一天一個數字，逐日取 max。
 * 不做 G-Counter —— 為一個已經沒有寫入者的鍵加一層形狀不划算。
 */
export function mergeDayNumbers(a, b) {
  if (!isObject(a) && !isObject(b)) return undefined;
  const left = isObject(a) ? a : {};
  const right = isObject(b) ? b : {};

  const out = {};
  for (const day of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const n = Math.max(numberOr0(left[day]), numberOr0(right[day]));
    if (n > 0) out[day] = n;
  }
  return out;
}

// ─── history：取聯集 ─────────────────────────────────────────────────────

/**
 * 跟讀紀錄。**取聯集**（本來就冪等），依 `at` 由新到舊排序、截到上限。
 *
 * 識別用 `at` + `sentenceId`：同一秒練同一句兩次的機率可以忽略，
 * 而用整筆內容當識別的話，多一個欄位（例如之後加了什麼）就會變成兩筆。
 */
export function mergeHistory(a, b) {
  const left = Array.isArray(a) ? a : null;
  const right = Array.isArray(b) ? b : null;
  if (!left && !right) return undefined;

  const seen = new Map();
  for (const record of [...(left ?? []), ...(right ?? [])]) {
    if (!isObject(record)) continue;
    const key = `${record.at ?? ''}|${record.sentenceId ?? ''}`;
    const existing = seen.get(key);
    // 同一個識別、內容卻不一樣時**不能用「先到的贏」** ——
    // 那樣 merge(a,b) 與 merge(b,a) 會挑到不同的那一筆（不滿足交換律），
    // 而兩台裝置就會一直互相推翻。改用同一條決定性的規則。
    // （現實中要同一毫秒練同一句才會撞到，但不滿足交換律就是不滿足。）
    seen.set(key, existing === undefined ? record : stable(existing, record));
  }

  // 排序也要是**全序**：只比 `at` 的話，時間一樣的幾筆會維持進來的順序，
  // 而那個順序取決於哪一邊先合 —— 一樣會壞掉交換律。
  return [...seen.values()].sort(byNewest).slice(0, HISTORY_LIMIT);
}

function byNewest(x, y) {
  const ax = String(x.at ?? '');
  const ay = String(y.at ?? '');
  if (ax !== ay) return ay.localeCompare(ax);
  const ix = String(x.sentenceId ?? '');
  const iy = String(y.sentenceId ?? '');
  if (ix !== iy) return ix.localeCompare(iy);
  return JSON.stringify(x).localeCompare(JSON.stringify(y));
}

// ─── reviews：每一格取比較新的那一次 ─────────────────────────────────────

/**
 * 情境對話的 AI 修正。鍵是「哪一段對話的第幾句」，值是那次的修正。
 *
 * 規則跟 `srs` 一樣是「每一格整筆取比較新的」，理由也一樣：
 * 逐欄位合併會拼出一個「修正句是新的、說明是舊的」而且沒有人看過的組合。
 *
 * 為什麼要合併而不是整包取新的一邊：這份東西是**花錢換來的**
 * （每一筆都是一次模型呼叫），整包取新的會把另一台裝置練過的那幾段丟掉，
 * 而丟掉的代價是下次練到那一段時再付一次錢。
 */
export function mergeReviews(a, b) {
  if (!isObject(a) && !isObject(b)) return undefined;
  const left = isObject(a) ? a : {};
  const right = isObject(b) ? b : {};

  const merged = {};
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    merged[key] = newerReview(left[key], right[key]);
  }

  // 超過上限時丟掉最舊的。排序要是**全序**（`at` 一樣時比鍵），
  // 不然兩邊丟掉的不是同一批，merge(a,b) 與 merge(b,a) 就會不一樣
  const keys = Object.keys(merged);
  if (keys.length <= REVIEW_LIMIT) return merged;

  const kept = keys
    .sort((x, y) => {
      const ax = String(merged[x]?.at ?? '');
      const ay = String(merged[y]?.at ?? '');
      if (ax !== ay) return ay.localeCompare(ax);
      return x.localeCompare(y);
    })
    .slice(0, REVIEW_LIMIT);

  const out = {};
  for (const key of kept) out[key] = merged[key];
  return out;
}

function newerReview(x, y) {
  if (!isObject(x)) return y;
  if (!isObject(y)) return x;

  const ax = String(x.at ?? '');
  const ay = String(y.at ?? '');
  if (ax !== ay) return ax > ay ? x : y;

  // 時間一模一樣（同一台裝置存了兩次、或時鐘的解析度不夠）：
  // 用一條決定性的規則挑，不能用「先到的贏」—— 那不滿足交換律
  return stable(x, y);
}

// ─── settings：整包取新的 ────────────────────────────────────────────────

/**
 * 偏好設定。比 `updatedAt`，**整包取比較新的那一邊**。
 *
 * 刻意不做逐欄位合併：那會產生一個「一半舊一半新」的組合，
 * 而那個組合是使用者從來沒有選過的狀態 —— 例如語速是新的、題型是舊的。
 */
export function mergeSettings(a, b) {
  if (!isObject(a) && !isObject(b)) return undefined;
  if (!isObject(a)) return b;
  if (!isObject(b)) return a;

  const ta = Number(a.updatedAt);
  const tb = Number(b.updatedAt);
  const hasA = Number.isFinite(ta);
  const hasB = Number.isFinite(tb);

  // 只有一邊有時間戳（另一邊是加這個欄位之前存的）→ 取有時間戳的
  if (hasA && !hasB) return a;
  if (hasB && !hasA) return b;
  if (hasA && hasB && ta !== tb) return ta > tb ? a : b;

  return stable(a, b);
}

// ─── srsVersion：取大的 ──────────────────────────────────────────────────

function mergeVersion(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) && !Number.isFinite(nb)) return undefined;
  return Math.max(Number.isFinite(na) ? na : 0, Number.isFinite(nb) ? nb : 0);
}

// ─── 工具 ────────────────────────────────────────────────────────────────

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberOr0(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 分不出新舊時的決定性選擇：比字串形式，取排在前面的那一個。
 *
 * 內容一樣時回哪一個都對；內容不一樣時，重點不是「挑對」而是
 * **每次都挑同一個** —— 隨便挑的話兩台裝置每次同步都會得到不同結果，
 * 然後 rev 一直往上跳、互相推翻，而畫面上看起來像設定會自己變。
 */
function stable(x, y) {
  return JSON.stringify(x) <= JSON.stringify(y) ? x : y;
}
