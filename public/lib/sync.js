// 跟伺服器交換學習進度。
//
// **階段 A 是手動的整包上傳／下載**，不是自動合併 —— 合併規則（每台裝置一格的
// 計數、每張卡取比較新的那一次）留在階段 B，設計寫在 `docs/accounts-and-sync.md`。
// 所以這裡的語意跟匯出／匯入一樣是「覆蓋」，而每一個覆蓋動作都要先講清楚
// 「用什麼覆蓋什麼」。
//
// 資料的形狀直接沿用備份檔的 `data`（`BACKUP_KEYS` 那五個鍵）——
// 伺服器不必另外定義一套格式，壞資料的檢查也能重用 `backup.js` 的那一整套。

import { api } from './session.js';
import { backupSummary, summaryText } from './backup.js';
import { exportState, importState } from './storage.js';

/** 上一次成功同步時伺服器給的 rev。用來做樂觀鎖，只活在記憶體裡。 */
let knownRev = null;

export function getKnownRev() {
  return knownRev;
}

/** 伺服器上目前有什麼。 */
export async function fetchRemote() {
  const remote = await api('/api/sync');
  knownRev = remote.rev;
  return remote;
}

/**
 * 把這台裝置的進度推上去。
 *
 * @param {{force?: boolean}} options force = 已經知道有衝突、使用者選擇覆蓋
 * @returns {Promise<{rev: number}>}
 * @throws {ConflictError} 伺服器上的版本比我們知道的新，而且沒有 force
 */
export async function push({ force = false } = {}) {
  // rev 不知道就先問一次 —— 帶著錯的 rev 上去只會拿到 409
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
 * 把伺服器上的進度拉下來蓋掉本機的。
 *
 * **呼叫端一定要先跟使用者確認** —— 這會覆蓋這台裝置上的所有進度。
 * 套用完要 `location.reload()`：設定與複習進度都有模組層級的快取，
 * 不重載的話會有模組還拿著舊資料（`backup.js` 的還原踩過這個坑）。
 */
export function applyRemote(remote) {
  importState(remote?.data ?? {});
  knownRev = remote?.rev ?? null;
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
