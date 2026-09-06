// 帳號的基本零件：密碼雜湊、session token、cookie、CSRF、登入退避。
//
// 全部是**純函式或只碰 crypto**，不碰檔案也不碰 express ——
// 所以 `test/auth.test.js` 測得到。這一層寫錯的代價比其他地方高，
// 而且錯了通常沒有徵兆（密碼比對用 `===` 照樣「會動」），所以刻意抽出來測。
//
// 零新相依套件：scrypt、隨機數、雜湊都在 `node:crypto` 裡。
//
// ─── 這個能擋什麼、不能擋什麼 ────────────────────────────────────────────
//
// 擋得住：路過的人燒掉 Azure／講評的配額（這是現在真正的曝險 ——
// `/api/pronunciation-feedback` 收 8 MB 上傳、直接花錢），以及別人看到或改掉
// 你的學習進度。
//
// 不打算擋：有心人針對性的攻擊、伺服器本機被入侵。這是一個自架的、
// 使用者是自己的 App，不是給不特定多數人用的服務。

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// scrypt 的成本參數。
//
// N=32768 需要約 128 × N × r = 33.5 MB 記憶體，而 Node 的 maxmem 預設是 32 MB
// —— 不明確指定就會丟 "Invalid scrypt params"，而且只在**第一次真的雜湊密碼**
// 時才炸（啟動、健康檢查都不會走到），很容易到部署完才發現。
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

/**
 * 雜湊密碼。成本參數存在字串裡，之後調高時舊密碼還驗得動。
 * @returns {Promise<string>} `scrypt$N$r$p$<salt base64>$<hash base64>`
 */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return [
    'scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), key.toString('base64'),
  ].join('$');
}

/**
 * 驗證密碼。**任何異常都回 false**，不丟例外 ——
 * 呼叫端是登入流程，壞掉的雜湊字串應該是「登入失敗」而不是 500。
 */
export async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;

    const expected = Buffer.from(hashB64, 'base64');
    const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    // timingSafeEqual 長度不同會丟例外，所以先比長度
    if (key.length !== expected.length) return false;
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// ─── session ─────────────────────────────────────────────────────────────

export const SESSION_COOKIE = 'sc_session';
export const SESSION_DAYS = 30;

/**
 * 產生一個 session token。
 *
 * **伺服器只存 `hash`，不存 `token`。** 這樣 `sessions.json` 外流
 * （備份、誤傳、容器 volume 被掛出來）不等於別人可以直接冒用身分 ——
 * 他拿到的是雜湊，反推不回原本的 token。
 */
export function newSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// ─── cookie ──────────────────────────────────────────────────────────────

/** 解析 `Cookie` 標頭。壞掉的一律當成沒有這個 cookie。 */
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // 壞掉的百分號編碼：跳過這一個，不要讓整個標頭解析失敗
    }
  }
  return out;
}

/**
 * 組 `Set-Cookie`。
 *
 * `secure` 是參數而不是寫死 true —— 本機開發是 `http://localhost`，
 * 帶了 `Secure` 的 cookie 在 http 上不會被存起來，登入會變成「按了沒反應」。
 * 呼叫端用「這個請求是不是 https」決定（見 index.js 的 isSecureRequest）。
 */
export function serializeCookie(name, value, { maxAge, secure, clear = false } = {}) {
  const parts = [
    `${name}=${clear ? '' : encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',                 // XSS 也偷不到
    'SameSite=Lax',             // 擋掉跨站 POST（CSRF 的路徑）
    `Max-Age=${clear ? 0 : maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// ─── CSRF ────────────────────────────────────────────────────────────────

/**
 * 改變狀態的請求要檢查 `Origin`。
 *
 * 為什麼 `SameSite=Lax` 之外還要這一道：SameSite 的實作細節在各家瀏覽器與
 * 各版本上有差異（尤其舊版 Safari），而 Origin 檢查是我們自己控制的、行為確定。
 * 兩道都很便宜，而 CSRF 在這個 App 上的後果是「別人可以清掉你的進度」。
 *
 * 沒有 Origin 標頭時**放行**：curl 與 healthcheck 不會送這個標頭，
 * 而真正的 CSRF 一定是瀏覽器發起的，瀏覽器一定會送。
 */
export function originAllowed(origin, host) {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// ─── 登入退避 ────────────────────────────────────────────────────────────

/**
 * 連續登入失敗就等久一點。擋的是暴力猜密碼。
 *
 * 存在記憶體裡就好：重啟清掉沒關係 —— 這是鈍器不是稽核紀錄，
 * 而且落地反而多一個要清理的檔案。
 */
export function createLoginGate({ baseMs = 1000, maxMs = 5 * 60_000 } = {}) {
  const fails = new Map();

  return {
    /** 還要等幾毫秒才能再試。0 = 可以試。 */
    retryAfter(key, now = Date.now()) {
      const entry = fails.get(key);
      if (!entry) return 0;
      return Math.max(0, entry.until - now);
    },
    fail(key, now = Date.now()) {
      const entry = fails.get(key) ?? { count: 0, until: 0 };
      entry.count += 1;
      // 第一次失敗不罰（打錯字很正常），從第二次開始指數退避
      const wait = entry.count < 2 ? 0 : Math.min(baseMs * 2 ** (entry.count - 2), maxMs);
      entry.until = now + wait;
      fails.set(key, entry);
      return wait;
    },
    succeed(key) {
      fails.delete(key);
    },
    /** 測試用。 */
    _size() {
      return fails.size;
    },
  };
}

// ─── 使用者名稱 ──────────────────────────────────────────────────────────

/** 帳號名稱的規則。回問題描述，沒問題回 null。 */
export function usernameProblem(name) {
  if (typeof name !== 'string') return '帳號名稱必須是文字。';
  const v = name.trim();
  if (v.length < 2) return '帳號名稱至少要 2 個字。';
  if (v.length > 32) return '帳號名稱最多 32 個字。';
  // 帳號名稱會變成檔案系統上找使用者的鍵，限制字元集是最省事的防線
  if (!/^[A-Za-z0-9_.-]+$/.test(v)) return '帳號名稱只能用英文字母、數字與 _ . - 這幾種符號。';
  return null;
}

/** 密碼的規則。 */
export function passwordProblem(password) {
  if (typeof password !== 'string') return '密碼必須是文字。';
  if (password.length < 8) return '密碼至少要 8 個字元。';
  if (password.length > 200) return '密碼太長了（上限 200 個字元）。';
  return null;
}
