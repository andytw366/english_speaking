// localStorage 包一層：私密瀏覽或停用儲存時不會炸掉，只是不記錄。

import { BACKUP_KEYS } from './backup.js';
import { LEGACY_SLOT, deviceId } from './device.js';
import { dayKey } from './practice.js';

const PREFIX = 'speaking-coach:';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    notifyWritten(key);
    return true;
  } catch {
    // 私密瀏覽、配額用盡都會走到這裡。功能照常，只是不記錄。
    return false;
  }
}

/**
 * 「有進度被寫進去了」——跨裝置同步靠這個知道什麼時候該推上去。
 *
 * 掛在 `write()` 而不是各模式裡：這裡是**所有**寫入的唯一出入口
 * （`read` / `write` 是模組私有的，每一個 export 都經過它），
 * 所以不必去改五個模式，也不會有哪個模式漏掉。
 *
 * 只有要同步的鍵才發（`BACKUP_KEYS`）—— `mode`（上次用哪個模式）之類的
 * 純本機偏好不該觸發一次網路請求。
 */
let suppressNotify = 0;

function notifyWritten(key) {
  if (suppressNotify > 0) return;
  if (!BACKUP_KEYS.includes(key)) return;
  try {
    window.dispatchEvent(new CustomEvent('progress-written', { detail: { key } }));
  } catch {
    // 沒有 window（測試直接 import 這個模組時）就算了
  }
}

// ─── 單字卡的間隔重複（Leitner 盒子制）─────────────────────────────────
// 盒子 1～5，答對就往上一盒、間隔拉長；答錯直接回第 1 盒。
// 用盒子制而不是 SM-2，是因為行為好預測、出問題也容易看懂。
const BOX_INTERVAL_DAYS = [0, 1, 3, 7, 21];
const DAY_MS = 24 * 60 * 60 * 1000;

// 複習進度的資料版本。只是給人看的記號（localStorage 裡看得到現在是第幾版），
// **不用它決定要不要搬** —— 見下面。
const SRS_VERSION = 2;
let migrated = false;

export function getSrsState() {
  const all = read('srs', {});
  if (migrated) return all;
  migrated = true;

  // 每次載入都跑一次搬家、只在真的有東西要搬時才寫回去。
  //
  // 為什麼不用版本號當關卡：那樣一來「版本已經是 2、但還有舊鍵留著」就永遠
  // 搬不動了 —— 而那個狀態做得出來（開發時手動塞舊資料就會遇到），
  // 症狀是進度看起來歸零、卻沒有任何錯誤。搬家本身是冪等的，
  // 每次載入跑一遍很便宜（srs 最多幾千個鍵），不需要靠版本號省這一趟。
  const before = Object.keys(all);
  const next = migrateSrs(all);
  const changed = before.length !== Object.keys(next).length ||
    before.some((key) => !(key in next));
  if (changed) {
    write('srs', next);
    write('srsVersion', SRS_VERSION);
  }
  return next;
}

/**
 * 版本 1 → 2：`band-3:2001` 這種鍵改成 `ecdict:2001`。
 *
 * 為什麼要改：難度分級（tier）與詞頻級距（band）是**同一批字的兩種切法**，
 * id 也是同一個（全域詞頻排名）。鍵裡帶牌組名稱的話，在 band-1 記熟的字
 * 換去 tier-1 練會變回「沒學過」—— 同一個字有兩份互不相干的複習進度，
 * 「各級進度」也會算出兩套數字。
 *
 * 精選牌組**不**併進來：它的 id 從 1 起算、跟 ECDICT 的字會撞
 * （精選第 1 張是 thorough，ECDICT 第 1 個是 say），所以留在 `curated:` 底下。
 *
 * 導出成純函式是為了測得到 —— 這段只跑一次，跑錯就是使用者的進度不見了。
 */
export function migrateSrs(all) {
  const next = {};
  for (const [key, value] of Object.entries(all ?? {})) {
    const m = /^band-\d+:(\d+)$/.exec(key);
    const nextKey = m ? `ecdict:${m[1]}` : key;
    const prev = next[nextKey];
    // 同一個字可能在兩個牌組裡都練過（band-1 與 band-2 不會撞，但重建過資料的話
    // 有可能）。留進度比較前面的那一份，不要讓合併把人往回推。
    next[nextKey] = !prev || score(value) >= score(prev) ? value : prev;
  }
  return next;
}

function score(state) {
  return (state?.box ?? 0) * 1000 + (state?.seen ?? 0);
}

/**
 * 每張卡的 SRS 鍵。**不是**用牌組 id 當前綴，是用牌組的 `keyspace`
 * （見 content/vocabulary/index.json）：band 與 tier 都是 `ecdict`，
 * 所以同一個字不論從哪一種牌組練到，都是同一份進度；精選是 `curated`，
 * 因為它的 id 會跟 ECDICT 的字撞。
 */
export function srsKeyOf(card) {
  return card.srsKey ?? String(card.id);
}

export function getCardState(card) {
  const key = typeof card === 'object' ? srsKeyOf(card) : String(card);
  return getSrsState()[key] ?? { box: 1, due: 0, seen: 0, correct: 0 };
}

export function recordAnswer(card, wasCorrect) {
  const key = typeof card === 'object' ? srsKeyOf(card) : String(card);
  const all = getSrsState();
  const prev = all[key] ?? { box: 1, due: 0, seen: 0, correct: 0 };
  const box = wasCorrect ? Math.min(prev.box + 1, BOX_INTERVAL_DAYS.length) : 1;
  all[key] = {
    box,
    due: Date.now() + BOX_INTERVAL_DAYS[box - 1] * DAY_MS,
    seen: prev.seen + 1,
    correct: prev.correct + (wasCorrect ? 1 : 0),
    // 最後一次作答的時間。**跨裝置合併時要靠它判斷哪一筆比較新**，
    // 而 `due` 做不到這件事 —— box 4 一週前答的卡，due 比 box 1 今天剛答的還晚。
    //
    // 現在（階段 A）還沒有合併，這個欄位只是先寫著：等到做自動同步時才加的話，
    // 在那之前練的每一張卡都沒有依據可以比。設計見 docs/accounts-and-sync.md
    at: Date.now(),
  };
  write('srs', all);
  return all[key];
}

/**
 * 排出這次要複習的順序：到期的先（越早到期越前面），再來是沒看過的新卡。
 */
export function buildQueue(cards) {
  const state = getSrsState();
  const now = Date.now();
  const due = [];
  const fresh = [];

  for (const card of cards) {
    const s = state[srsKeyOf(card)];
    if (!s) fresh.push(card);
    else if (s.due <= now) due.push({ card, due: s.due });
  }
  due.sort((a, b) => a.due - b.due);
  return [...due.map((d) => d.card), ...fresh];
}

export function srsSummary(cards) {
  const state = getSrsState();
  const now = Date.now();
  let due = 0;
  let fresh = 0;
  let learning = 0;
  let mastered = 0;

  for (const card of cards) {
    const s = state[srsKeyOf(card)];
    if (!s) { fresh++; continue; }
    if (s.due <= now) due++;
    if (s.box >= BOX_INTERVAL_DAYS.length) mastered++;
    else learning++;
  }
  return { due, fresh, learning, mastered, total: cards.length };
}

/**
 * 每一級的學習進度。
 *
 * **為什麼不直接統計卡片**：`srsSummary()` 要把整個牌組的卡片傳進來，而六個
 * 分級檔加起來是 3 MB —— 為了畫一排進度條把整個字庫載下來太蠢。
 * 而卡片 id 就是全域詞頻排名，`tier-map.json` 用一個 10,000 長度的陣列
 * （20 KB）記「id 是第幾級」，所以只要這個小檔案加 localStorage 就算得出來。
 *
 * 純函式：`now` 一定要傳（測試不能靠真實時鐘），srs 狀態也是參數。
 *
 * @param {object} srsState getSrsState() 的結果
 * @param {{ byId: number[], tiers: Array<{id:string, order:number, label:string, count:number}> }} tierMap
 * @param {number} now
 */
export function tierProgress(srsState, tierMap, now = Date.now()) {
  const tiers = (tierMap?.tiers ?? []).map((t) => ({
    ...t, due: 0, learning: 0, mastered: 0, fresh: t.count, seen: 0,
  }));
  const byOrder = new Map(tiers.map((t) => [t.order, t]));
  const byId = tierMap?.byId ?? [];

  for (const [key, state] of Object.entries(srsState ?? {})) {
    const m = /^ecdict:(\d+)$/.exec(key);
    if (!m) continue;                       // 精選與跟讀的鍵不算在分級裡
    const tier = byOrder.get(byId[Number(m[1]) - 1]);
    if (!tier) continue;                    // 資料重建後 id 可能超出範圍
    tier.seen += 1;
    if (state.box >= BOX_INTERVAL_DAYS.length) tier.mastered += 1;
    else tier.learning += 1;
    if (state.due <= now) tier.due += 1;
  }

  for (const t of tiers) t.fresh = Math.max(0, t.count - t.seen);
  return tiers;
}

export function resetSrs() {
  write('srs', {});
  write('srsVersion', SRS_VERSION);
  // 每天練了幾個是另一回事（那是「我有沒有回來練」的紀錄，不是複習排程），
  // 清複習進度不該把連續天數一起清掉
}

// ─── 每天練了什麼（六個模式共用）──────────────────────────────────────────
//
// 形狀：{ vocabulary: { '2026-09-05': { 'dev-a1b2': 23 } }, listening: { … }, … }
//
// **一天一格「每台裝置各記各的」（G-Counter）**，不是一天一個數字。
// 為什麼：跨裝置同步時，一天的數字要能合併，而
//   取 max → 手機 3、桌機 2 得到 3（少算）
//   相加   → 得到 5，但重複同步一次就變 10（不冪等）
// 每台一格之後：寫入只加自己那一格、讀取把所有格子加起來、合併逐格取 max ——
// 同時不少算也不膨脹。合併規則在 `lib/merge.js`，設計在 docs/accounts-and-sync.md。
//
// 舊資料（一天一個數字）讀進來時搬到固定的 `legacy` 格，**不是搬到本機那一格** ——
// 兩台裝置各搬一次的話，同一段歷史會被算成兩台的份而加倍。
//
// **為什麼要另外記一份、不從各模式自己的資料算**：
//   - 單字卡的 `srs` 每張卡只留**最後一次**的狀態，答過就被下一次蓋掉 ——
//     算不出「今天練了幾張」，更算不出連續天數；
//   - 聽力、中翻英、情境對話**根本沒有存任何東西**，答完就沒了。
//
// **為什麼是一天一個數字、不是一筆一筆的紀錄**：畫面上要的就是一個數字。
// 一天 20 筆、一年 7,000 筆，只為了算「今天幾張」要掃過整份，不值得。
// 跟讀例外 —— 它本來就需要逐筆紀錄（分數、弱點音會回頭決定抽句），
// 那份 `history` 留著，這裡只是額外記一個計數讓六個模式的進度用同一種形狀讀。

/** 有進度的模式。順序就是首頁與設定裡的顯示順序。 */
export const MODE_IDS = ['vocabulary', 'listening', 'translation', 'dialogue', 'shadowing'];

/** 保留幾天。一年多，足夠算連續天數，也不會讓 localStorage 無限長大。 */
export const ACTIVITY_DAY_LIMIT = 400;

/**
 * 從舊資料生出計數表。
 *
 * 純函式，因為它只跑一次而且**跑錯就是使用者的連續天數歸零** ——
 * 那種東西沒有錯誤訊息，只有「咦我明明有練」。
 *
 * @param {{ vocabDays?: Record<string, number>, history?: Array<{at: *, score: *}> }} old
 */
export function buildActivity({ vocabDays, history } = {}) {
  const activity = {};

  // 單字卡：舊的 vocabDays 是一天一個數字，搬進 legacy 格
  if (vocabDays && typeof vocabDays === 'object') {
    activity.vocabulary = toSlots(vocabDays);
  }

  // 跟讀：從逐筆紀錄數出每天幾句。只算有分數的 —— 沒分數代表沒真的練成一句
  if (Array.isArray(history)) {
    const days = {};
    for (const record of history) {
      if (typeof record?.score !== 'number') continue;
      const key = dayKey(record.at);
      if (key) days[key] = (days[key] ?? 0) + 1;
    }
    if (Object.keys(days).length) activity.shadowing = toSlots(days);
  }

  return activity;
}

/** 一天一個數字 → 一天一格（全部進 `legacy`）。 */
function toSlots(days) {
  const out = {};
  for (const [key, value] of Object.entries(days)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) out[key] = { [LEGACY_SLOT]: Math.floor(n) };
  }
  return out;
}

/** 只留認得的模式與合理的數字。localStorage 是使用者改得到的。 */
function normalizeActivity(raw) {
  const out = {};
  for (const mode of MODE_IDS) {
    const days = raw?.[mode];
    if (!days || typeof days !== 'object' || Array.isArray(days)) continue;
    out[mode] = days;
  }
  return out;
}

let activityReady = false;

export function getActivity() {
  const raw = read('activity', null);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return normalizeActivity(raw);

  // 第一次：從舊的 vocabDays 與跟讀紀錄生一份出來，這樣改版之後
  // 既有的連續天數不會歸零。舊鍵留著不刪，萬一要退版資料還在。
  if (activityReady) return {};
  activityReady = true;
  const built = buildActivity({ vocabDays: read('vocabDays', null), history: read('history', []) });
  if (Object.keys(built).length) write('activity', built);
  return built;
}

/**
 * 某一天、某個模式練了幾個。壞掉的值當成 0。
 *
 * **兩種形狀都要讀得懂**：新的是一天一格（把格子加起來），
 * 舊的是一天一個數字（還沒被搬過的 localStorage 就長這樣）。
 * 少了這道相容，改版之後使用者的連續天數會直接歸零。
 */
export function activityCount(activity, mode, key) {
  return countOf(activity?.[mode]?.[key]);
}

function countOf(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    let total = 0;
    for (const slot of Object.values(value)) {
      const n = Number(slot);
      if (Number.isFinite(n) && n > 0) total += Math.floor(n);
    }
    return total;
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 某個模式有練過的日子（連續天數用）。 */
export function activityDays(activity, mode) {
  const days = activity?.[mode] ?? {};
  return new Set(Object.keys(days).filter((key) => activityCount(activity, mode, key) > 0));
}

/** 今天六個模式各練了幾個、加起來幾個。首頁用這個。 */
export function activityToday(activity, key) {
  const byMode = {};
  let total = 0;
  for (const mode of MODE_IDS) {
    byMode[mode] = activityCount(activity, mode, key);
    total += byMode[mode];
  }
  return { byMode, total };
}

/**
 * 某個模式在某一天加 n。純函式，回一份新的計數表。
 *
 * **只加自己那一格**（`slot`），別台裝置的格子一個都不碰 —— 那是 G-Counter
 * 能夠冪等合併的全部原因。真正的寫入一定要帶這台裝置的 id
 * （`recordActivity()` 會帶）；`slot` 省略時進 `legacy`，那是給搬家與測試用的。
 */
export function addActivity(activity, mode, key, n = 1, {
  slot = LEGACY_SLOT, limit = ACTIVITY_DAY_LIMIT,
} = {}) {
  if (!MODE_IDS.includes(mode) || !key || !Number.isFinite(n) || n <= 0) {
    return { ...activity };
  }
  const days = { ...(activity?.[mode] ?? {}) };
  const before = days[key];
  // 舊形狀（一天一個數字）先攤成 legacy 格再加，不然會把它整個蓋掉
  const slots = before && typeof before === 'object' && !Array.isArray(before)
    ? { ...before }
    : (countOf(before) > 0 ? { [LEGACY_SLOT]: countOf(before) } : {});
  slots[slot] = (Number(slots[slot]) || 0) + Math.floor(n);
  days[key] = slots;

  // 只留最近的幾天。鍵是 YYYY-MM-DD，字串由大到小排就是由新到舊。
  const keys = Object.keys(days).sort().reverse();
  const trimmed = keys.length <= limit
    ? days
    : Object.fromEntries(keys.slice(0, limit).map((k) => [k, days[k]]));

  return { ...activity, [mode]: trimmed };
}

/**
 * 把每日紀錄全部清掉（連續天數也跟著歸零）。
 *
 * 刻意跟「清除複習進度」「清除跟讀紀錄」分開：那兩個清的是**成績**
 * （哪個字進到第幾盒、每一句幾分），這個清的是**有沒有回來練**。
 * 混在一起的話，想重設複習排程的人會連連續天數一起失去，
 * 而那是這個 App 裡最不該不小心弄丟的東西。
 */
export function clearActivity() {
  write('activity', {});
  write('vocabDays', {});   // 舊鍵也清掉，不然下次載入又會從它生一份出來
}

/** 記一次練習（預設今天、加一）。回傳更新後的計數表。 */
export function recordActivity(mode, n = 1, now = Date.now()) {
  const next = addActivity(getActivity(), mode, dayKey(new Date(now)), n, { slot: deviceId() });
  write('activity', next);
  return next;
}

// ─── 備份 ────────────────────────────────────────────────────────────────

/**
 * 讀出所有要備份的鍵的**原始值**。
 *
 * 刻意不套用預設值與 migration：備份要存的是「這台瀏覽器現在真的有什麼」，
 * 補過預設值之後存出去，還原到另一台會把那些預設值當成使用者的選擇。
 */
export function exportState() {
  const state = {};
  for (const key of BACKUP_KEYS) {
    const value = read(key, undefined);
    if (value !== undefined) state[key] = value;
  }
  return state;
}

/**
 * 把備份寫回去。**只寫白名單裡的鍵**（parseBackup 已經濾過一次，這裡是第二道）。
 *
 * 是覆蓋不是合併：合併兩份複習進度要決定「同一個字兩邊都有時聽誰的」，
 * 而任何一種選法都會在某些情況下把人往回推。覆蓋至少是可預期的，
 * 呼叫端負責在覆蓋前問清楚。
 *
 * @returns {string[]} 實際寫進去的鍵
 */
export function importState(data) {
  const written = [];
  // 套用進來的資料**不發「有進度被寫進去」事件**。
  //
  // 發的話會變成一個迴圈：同步把合併結果寫進來 → 事件觸發 → 又排一次推上去。
  // 不會無限（下一次合併是 no-op），但每次同步都會多一輪沒有必要的請求。
  // 這裡寫進去的東西**本來就是從伺服器來的**，沒有什麼要推回去。
  suppressNotify += 1;
  try {
    for (const key of BACKUP_KEYS) {
      if (data?.[key] === undefined) continue;
      if (write(key, data[key])) written.push(key);
    }
  } finally {
    suppressNotify -= 1;
  }
  return written;
}

// ─── 跟讀練習紀錄 ────────────────────────────────────────────────────────
//
// 這份紀錄不只是「看過的清單」—— 它會回頭決定下一句抽什麼（見 lib/practice.js）：
// 分數低的、久沒練的、以及練得到你常錯的音的句子會比較常出現。
// 所以欄位不能只留分數，`problemWords` 的 issue 分類是弱點加權的唯一來源。

/** 保留的筆數上限。200 筆大約是兩三個月的練習量，趨勢圖也只看最近 20 筆。 */
const HISTORY_LIMIT = 200;

/**
 * 記一次練習。
 *
 * `at` 用 ISO 字串而不是毫秒數：間隔重複要算「上次練是多久以前」，
 * 而 `Date.parse(1234567)` 會回 NaN —— 存數字的話那一句會被當成「時間壞掉」。
 * （舊版存的是數字，`practice.js` 兩種都讀得懂，不用洗資料。）
 *
 * @param {object} entry
 * @param {*} entry.sentenceId 例句 id，「重練這句」與依句子彙整成績都靠它
 * @param {string} entry.sentenceText 當時的句子（例句改過之後紀錄仍然看得懂）
 * @param {number|null} entry.score 0～100
 * @param {Array<{word:string, issue:string}>} [entry.problemWords] 弱點加權的來源
 */
export function addAttempt(entry) {
  const list = read('history', []);
  list.unshift({ ...entry, at: new Date().toISOString() });
  const trimmed = list.slice(0, HISTORY_LIMIT);

  if (!write('history', trimmed)) {
    // 配額滿了：砍掉一半再試一次，總比整份紀錄寫不進去好
    const half = trimmed.slice(0, Math.floor(trimmed.length / 2));
    if (write('history', half)) {
      console.warn('[storage] 空間不足，已丟棄較舊的一半練習紀錄');
      return half;
    }
    return trimmed; // 還是寫不進去：回傳記憶體中的清單，至少這次的畫面是對的
  }
  return trimmed;
}

export function getHistory() {
  const list = read('history', []);
  return Array.isArray(list) ? list.filter((r) => r && typeof r === 'object') : [];
}

export function clearHistory() {
  write('history', []);
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
