// 使用者、session 與學習進度的落地。
//
// 為什麼是 JSON 檔而不是資料庫：要存的東西就是 `BACKUP_KEYS` 那五個鍵，
// 一個使用者總共不到 1 MB（`srs` 就算 10,040 個字全練過也才 0.57 MB，
// `activity` 一年約 36 KB）。加一個資料庫等於多一個相依套件、多一份 schema
// 搬家的責任，換來的是這個規模用不到的東西。
//
// ⚠️ **`DATA_DIR` 在 Docker 裡一定要掛 volume。** 沒掛的話容器一重建
// （`docker compose up --build`）使用者的全部學習進度就消失，
// 而症狀是「重新部署之後從頭開始」，沒有任何錯誤訊息。
// 見 docker-compose.yml 的 `userdata` volume 與 Dockerfile 的 chown。

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { hashToken, newSession, SESSION_DAYS } from './auth.js';

/** 進度檔保留幾個舊版本。 */
const KEEP_REVISIONS = 10;

/** 一個使用者的進度上限。超過就拒收 —— 正常值不到 1 MB。 */
export const MAX_DATA_BYTES = 8 * 1024 * 1024;

export class StoreError extends Error {
  constructor(httpStatus, userMessage) {
    super(userMessage);
    this.httpStatus = httpStatus;
    this.userMessage = userMessage;
  }
}

export function createStore(dir) {
  const usersFile = path.join(dir, 'users.json');
  const sessionsFile = path.join(dir, 'sessions.json');
  const userDir = path.join(dir, 'u');

  /**
   * 一次只讓一個寫入者進來。
   *
   * express 是單執行緒，但 async 的讀 → 改 → 寫中間會讓出去 ——
   * 兩個請求交錯的話後寫的會蓋掉先寫的（例如同時註冊兩個帳號只留下一個）。
   * 用一條 Promise 鏈把所有寫入串起來，比對每個檔案各自管鎖簡單也不會漏。
   */
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const run = queue.then(fn, fn);
    // 佇列本身不能被單次失敗打斷，所以吞掉錯誤（錯誤照樣回給呼叫端）
    queue = run.then(() => {}, () => {});
    return run;
  };

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      // 檔案壞掉時**不要**當成空的往下走 —— 那等於把使用者的進度靜靜清空。
      // 寧可整個請求失敗，讓人看得到並且去翻 u/<id>.rev-N.json
      throw new StoreError(500, `讀取 ${path.basename(file)} 失敗：${err.message}`);
    }
  }

  /**
   * 原子寫入：先寫暫存檔再 rename。
   *
   * 直接寫目標檔案的話，寫到一半斷電或容器被砍，留下的是一個**被截斷的 JSON**
   * —— 下次開啟就是「進度全沒了」。同一個檔案系統上 rename 是原子的。
   */
  async function writeJson(file, value) {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  const dataFile = (userId) => path.join(userDir, `${userId}.json`);

  return {
    dir,

    async init() {
      await fs.mkdir(userDir, { recursive: true });
    },

    // ─── 使用者 ──────────────────────────────────────────────────────────

    async listUsers() {
      return (await readJson(usersFile, { users: [] })).users ?? [];
    },

    async findUser(username) {
      const users = await this.listUsers();
      const wanted = String(username).trim().toLowerCase();
      return users.find((u) => u.username.toLowerCase() === wanted) ?? null;
    },

    async userCount() {
      return (await this.listUsers()).length;
    },

    /**
     * 擁有者 —— 第一個註冊的帳號。金鑰設定只有他能改（見 server/settings.js）。
     *
     * `role` 是註冊時寫進去的，但**舊的 users.json 沒有這個欄位**
     * （帳號是在這個功能之前建的），所以找不到 role 時退回「清單裡的第一個」
     * —— 那就是最早註冊的那一個。少了這條退路的話，既有的部署升級之後
     * 會變成「沒有人是擁有者」，誰都改不了金鑰。
     */
    async owner() {
      const users = await this.listUsers();
      return users.find((u) => u.role === 'owner') ?? users[0] ?? null;
    },

    async createUser(username, passwordHash) {
      return exclusive(async () => {
        const users = (await readJson(usersFile, { users: [] })).users ?? [];
        const wanted = String(username).trim().toLowerCase();
        if (users.some((u) => u.username.toLowerCase() === wanted)) {
          throw new StoreError(409, '這個帳號名稱已經有人用了。');
        }
        const user = {
          id: crypto.randomUUID(),
          username: String(username).trim(),
          passwordHash,
          // 第一個帳號就是擁有者。寫進檔案而不是每次算「誰最早」——
          // 之後刪掉某個帳號時，剩下的人不會莫名其妙變成擁有者
          role: users.length === 0 ? 'owner' : 'member',
          createdAt: new Date().toISOString(),
        };
        await writeJson(usersFile, { users: [...users, user] });
        return user;
      });
    },

    // ─── session ─────────────────────────────────────────────────────────

    async createSession(userId) {
      const { token, hash } = newSession();
      const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
      await exclusive(async () => {
        const all = await readJson(sessionsFile, {});
        // 順手清掉過期的，不需要另外排程
        const now = Date.now();
        const kept = Object.fromEntries(
          Object.entries(all).filter(([, s]) => s.expiresAt > now)
        );
        kept[hash] = { userId, expiresAt };
        await writeJson(sessionsFile, kept);
      });
      return { token, expiresAt };
    },

    /** token → 使用者。找不到、過期、使用者被刪掉都回 null。 */
    async userForToken(token) {
      if (!token) return null;
      const all = await readJson(sessionsFile, {});
      const session = all[hashToken(token)];
      if (!session || session.expiresAt <= Date.now()) return null;
      const users = await this.listUsers();
      return users.find((u) => u.id === session.userId) ?? null;
    },

    async deleteSession(token) {
      if (!token) return;
      await exclusive(async () => {
        const all = await readJson(sessionsFile, {});
        delete all[hashToken(token)];
        await writeJson(sessionsFile, all);
      });
    },

    // ─── 學習進度 ────────────────────────────────────────────────────────

    /** 沒有存過的人回 rev 0 與空的 data —— 不是錯誤，是還沒同步過。 */
    async readData(userId) {
      return readJson(dataFile(userId), { rev: 0, updatedAt: null, data: {} });
    },

    /**
     * 寫進度。`expectedRev` 對不上就丟 409（樂觀鎖）。
     *
     * 沒有這道的話，兩台裝置幾乎同時上傳，後到的會**無聲**蓋掉先到的 ——
     * 而使用者看到的只是「咦，昨天練的怎麼不見了」。
     */
    async writeData(userId, data, expectedRev) {
      return exclusive(async () => {
        const current = await readJson(dataFile(userId), { rev: 0, updatedAt: null, data: {} });
        if (Number(expectedRev) !== current.rev) {
          const err = new StoreError(409, '這份進度在別的裝置上已經更新過了。');
          err.current = current;
          throw err;
        }

        const next = {
          rev: current.rev + 1,
          updatedAt: new Date().toISOString(),
          data,
        };

        // 覆蓋之前先留一份舊的。**這是合併寫錯時唯一的救援** ——
        // 沒留的話，使用者能倚靠的只有他自己有沒有記得手動匯出過
        if (current.rev > 0) {
          await writeJson(path.join(userDir, `${userId}.rev-${current.rev}.json`), current);
          await pruneRevisions(userId, current.rev);
        }

        await writeJson(dataFile(userId), next);
        return next;
      });
    },

    /**
     * 合併寫入：在**同一個獨佔區段**裡讀 → 合 → 寫。
     *
     * 這是它跟「GET 之後再 PUT」的差別 —— 中間沒有讓別人插進來的空隙，
     * 所以不需要樂觀鎖也不會有 409 迴圈。合併規則本身由呼叫端傳進來
     * （`mergeState`，純函式），store 只負責「原子地做完這件事」。
     *
     * @param {string} userId
     * @param {(current: object) => object} merge 吃目前的 data，回合併後的 data
     */
    async mergeData(userId, merge) {
      return exclusive(async () => {
        const current = await readJson(dataFile(userId), { rev: 0, updatedAt: null, data: {} });
        const merged = merge(current.data ?? {});

        // 合併之後跟原本一模一樣就不寫了 —— 不然每次同步都會多一個版本，
        // 而保留的 10 版會被沒有變化的紀錄佔滿，真正想回溯的那一版就被推掉了
        if (JSON.stringify(merged) === JSON.stringify(current.data ?? {})) {
          return { ...current, data: merged, changed: false };
        }

        const next = {
          rev: current.rev + 1,
          updatedAt: new Date().toISOString(),
          data: merged,
        };

        if (current.rev > 0) {
          await writeJson(path.join(userDir, `${userId}.rev-${current.rev}.json`), current);
          await pruneRevisions(userId, current.rev);
        }
        await writeJson(dataFile(userId), next);
        return { ...next, changed: true };
      });
    },
  };

  async function pruneRevisions(userId, latestRev) {
    const cutoff = latestRev - KEEP_REVISIONS;
    if (cutoff < 1) return;
    let names = [];
    try {
      names = await fs.readdir(userDir);
    } catch {
      return;
    }
    const prefix = `${userId}.rev-`;
    await Promise.all(names.map(async (name) => {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) return;
      const rev = Number(name.slice(prefix.length, -'.json'.length));
      // 清不掉舊版本不是錯誤，下次還會再試 —— 別讓它害整個寫入失敗
      if (Number.isFinite(rev) && rev <= cutoff) {
        await fs.rm(path.join(userDir, name)).catch(() => {});
      }
    }));
  }
}
