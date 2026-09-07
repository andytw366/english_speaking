// 跟伺服器交換學習進度。
//
// 階段 B：**自動合併**。合併規則在 `lib/merge.js`（純函式，伺服器 import 同一份），
// 而合併本身是在伺服器上做的 —— 讀→合→寫在同一個獨佔區段裡完成，
// 所以不會有「讀完之後另一台先寫進去」的 409 迴圈。設計在
// docs/accounts-and-sync.md。
//
// 這一層負責的是**什麼時候同步**與**失敗了怎麼辦**：
//   載入時          先合併下來再開始練
//   切到背景        推上去
//   有寫入之後      debounce 10 秒推上去
//   失敗            什麼都不做，繼續練，下一個時機再試
//
// 「手動上傳／下載」（整包覆蓋）留著 —— 自動合併壞掉時那是唯一的逃生門。

import { api } from './session.js';
import { backupSummary, summaryText } from './backup.js';
import { exportState, importState } from './storage.js';

/** 有寫入之後等多久才推上去。練一輪單字卡會寫幾十次，每次都推太吵。 */
const PUSH_DEBOUNCE_MS = 10_000;

/**
 * 自動同步的開關。**每台裝置各自決定**，所以是自己一個 localStorage 鍵，
 * 不是放在 `settings` 裡 —— `settings` 會跟著同步，那就變成
 * 「在一台關掉，每一台都關掉」，而這是一個關於「這台裝置」的選擇。
 *
 * 用途有兩個：合併萬一出問題時使用者可以關掉它（配合「整包覆蓋」自救），
 * 以及讓 `test/ui.mjs` 的其他段落不受同步干擾 ——
 * 那些測試會塞假的 localStorage 再重載，而自動同步會把伺服器上的東西合進來，
 * 假資料就不是假資料了。
 */
const AUTO_KEY = 'speaking-coach:autoSync';

export function isAutoSyncOn() {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setAutoSync(on) {
  try {
    if (on) localStorage.removeItem(AUTO_KEY);
    else localStorage.setItem(AUTO_KEY, 'off');
  } catch { /* 私密瀏覽：這次生效就好 */ }
}

/** 上一次成功同步時伺服器給的 rev。手動上傳的樂觀鎖用，只活在記憶體裡。 */
let knownRev = null;

/** 有沒有還沒推上去的變更。 */
let dirty = false;

let timer = null;
let inFlight = null;
let started = false;

export function getKnownRev() {
  return knownRev;
}

export function isDirty() {
  return dirty;
}

/** 伺服器上目前有什麼。 */
export async function fetchRemote() {
  const remote = await api('/api/sync');
  knownRev = remote.rev;
  return remote;
}

// ─── 自動同步 ────────────────────────────────────────────────────────────

/**
 * 開始自動同步。`app.js` 在確認登入之後呼叫一次。
 *
 * @returns {Promise<{merged: boolean}>} 第一次合併的結果 ——
 *   `merged` 為 true 代表本機的資料被伺服器上的東西改過了，
 *   呼叫端要重畫（或重載）才看得到。
 */
export async function start() {
  if (started) return { merged: false };
  if (!isAutoSyncOn()) return { merged: false };
  started = true;

  // 有寫入就標記，然後 debounce 推上去。
  // `storage.js` 的 `write()` 是**所有**寫入的唯一出入口，所以掛在那裡就夠了 ——
  // 不必去改五個模式，也不會有哪個模式漏掉
  window.addEventListener('progress-written', schedulePush);

  // 切到背景時推。手機上「切出去」跟「關掉」幾乎是同一件事，
  // 而 visibilitychange 是唯一在那個時機還來得及發請求的事件
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void push({ immediate: true });
  });

  // 回到前景時拉一次：另一台裝置可能在這段時間練過
  window.addEventListener('focus', () => { void syncNow(); });

  return syncNow();
}

/** 立刻合併一次（推上去 + 把合併結果套回本機）。 */
export async function syncNow() {
  // 同一時間只跑一次 —— 兩個時機同時觸發（切回前景又剛好 debounce 到）
  // 會送出兩份一樣的東西，而伺服器要各寫一個版本
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const before = JSON.stringify(exportState());
      const result = await api('/api/sync/merge', { method: 'POST', body: { data: exportState() } });

      knownRev = result.rev;
      dirty = false;

      const after = JSON.stringify(result.data ?? {});
      if (after === before) return { merged: false };

      // 伺服器合出來的東西跟本機不一樣 → 套用它
      importState(result.data ?? {});
      return { merged: true };
    } catch (err) {
      // **失敗什麼都不做。** 離線、伺服器掛了、session 過期都走這裡：
      // 保持 dirty，下一個時機再試。唯一會讓使用者看到東西的是 401，
      // 而那個由 `session.js` 統一處理（切回登入畫面）——
      // 不重新登入的話永遠同步不上去，那件事非講不可
      console.warn('[sync] 這次沒同步成功，之後會再試：', err.message);
      return { merged: false, error: err };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** 有東西要推。debounce 之後才真的送。 */
function schedulePush() {
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(() => { void push(); }, PUSH_DEBOUNCE_MS);
}

async function push({ immediate = false } = {}) {
  if (!dirty && !immediate) return;
  clearTimeout(timer);
  await syncNow();
}

// ─── 手動（整包覆蓋）────────────────────────────────────────────────────
//
// 自動合併之外還留著這兩條，理由是**逃生門**：合併規則萬一出問題，
// 「用這一台的整份蓋過去」是使用者唯一能自己救回來的動作。
// 語意是覆蓋，所以每一次都要先講清楚用什麼覆蓋什麼。

/**
 * 把這台裝置的進度**整包覆蓋**上去。
 *
 * @param {{force?: boolean}} options force = 已經知道有衝突、使用者選擇覆蓋
 * @throws {ConflictError} 伺服器上的版本比我們知道的新，而且沒有 force
 */
export async function pushOverwrite({ force = false } = {}) {
  if (knownRev === null || force) {
    const remote = await api('/api/sync');
    if (!force && remote.rev !== 0) {
      // 這台裝置還沒讀過伺服器上的東西，直接覆蓋會吃掉另一台的進度
      throw new ConflictError(remote);
    }
    knownRev = remote.rev;
  }

  try {
    const res = await api('/api/sync', {
      method: 'PUT',
      body: { rev: knownRev, data: exportState() },
    });
    knownRev = res.rev;
    dirty = false;
    return res;
  } catch (err) {
    if (err.status === 409) {
      knownRev = err.body?.current?.rev ?? knownRev;
      throw new ConflictError(err.body?.current);
    }
    throw err;
  }
}

/**
 * 把伺服器上的進度拉下來**蓋掉**本機的。
 *
 * **呼叫端一定要先跟使用者確認** —— 這會覆蓋這台裝置上的所有進度。
 * 套用完要 `location.reload()`：設定與複習進度都有模組層級的快取，
 * 不重載的話會有模組還拿著舊資料（`backup.js` 的還原踩過這個坑）。
 */
export function applyRemote(remote) {
  importState(remote?.data ?? {});
  knownRev = remote?.rev ?? null;
  dirty = false;
}

export class ConflictError extends Error {
  constructor(current) {
    super('伺服器上的進度比這台裝置知道的新。');
    this.name = 'ConflictError';
    this.current = current;
  }
}

/** 「複習進度 123 張、跟讀紀錄 45 筆…」——覆蓋之前要讓人看得到用什麼覆蓋。 */
export function describe(data) {
  try {
    return summaryText(backupSummary(data ?? {}));
  } catch {
    return '（看不懂這份資料的內容）';
  }
}

/** 這台裝置現在有什麼。跟 `describe(remote.data)` 並排給使用者比較。 */
export function describeLocal() {
  return describe(exportState());
}
