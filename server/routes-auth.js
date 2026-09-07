// 帳號與同步的端點，以及「這個請求有沒有登入」那道關卡。
//
// 抽成一個檔案而不是塞進 index.js：index.js 一 import 就 `app.listen()`，
// 測不進去；這裡是一個吃 store 回傳 router 的工廠，所以
// `test/routes-auth.test.js` 可以用假的 store 直接測。

import express from 'express';

import {
  SESSION_COOKIE, SESSION_DAYS, createLoginGate, hashPassword, originAllowed,
  parseCookies, passwordProblem, serializeCookie, usernameProblem, verifyPassword,
} from './auth.js';
import { MAX_DATA_BYTES, StoreError } from './store.js';
// 合併規則跟前端**共用同一份**（純函式，沒有 DOM 也沒有 localStorage）。
// 伺服器自己再寫一份的話，兩邊一定會分岔，而分岔的症狀是
// 「同步之後數字對不起來」，沒有錯誤訊息。
import { mergeState } from '../public/lib/merge.js';

/** 這些鍵才會被存進伺服器 —— 跟前端的 `BACKUP_KEYS` 是同一份清單。 */
export const SYNC_KEYS = ['srs', 'srsVersion', 'activity', 'vocabDays', 'history', 'settings'];

/**
 * 不需要登入的路徑。**只有這兩種**：
 *   /api/health   Docker 的 healthcheck 要用，而 healthcheck 沒有 cookie
 *   /api/auth/*   還沒登入才會呼叫它
 *
 * 題庫（/api/content、/api/vocabulary）**也要登入**。它們不是機密，
 * 但那是好幾 MB 的靜態檔，不擋等於免費給人當 CDN。
 */
export function isPublicPath(pathname) {
  return pathname === '/api/health' || pathname.startsWith('/api/auth/');
}

/** 這個請求是不是走 https（決定 cookie 要不要帶 Secure）。 */
export function isSecureRequest(req) {
  if (req.secure) return true;
  // Caddy 在前面時後端看到的是 http，真正的協定在這個標頭裡。
  // 只信任第一個值 —— 後面的可能是使用者自己加的
  const forwarded = req.headers['x-forwarded-proto'];
  return String(forwarded ?? '').split(',')[0].trim() === 'https';
}

export function createAuthRoutes(store, { inviteCode = '' } = {}) {
  const router = express.Router();
  const gate = createLoginGate();

  const cookieFor = (req, token, expiresAt) => serializeCookie(SESSION_COOKIE, token, {
    maxAge: Math.floor((expiresAt - Date.now()) / 1000),
    secure: isSecureRequest(req),
  });

  const publicUser = (user) => ({ username: user.username, createdAt: user.createdAt });

  // ─── 註冊 ──────────────────────────────────────────────────────────────
  //
  // 公開網域上開放註冊 = 任何人都能建帳號來燒你的 Azure 配額。規則：
  //   1. 一個帳號都還沒有時可以註冊（第一個帳號＝擁有者）
  //   2. 之後預設關閉
  //   3. 要再開就在 .env 設 INVITE_CODE，註冊時要帶對
  router.post('/register', async (req, res, next) => {
    try {
      const { username, password, inviteCode: given } = req.body ?? {};

      const problem = usernameProblem(username) ?? passwordProblem(password);
      if (problem) return res.status(400).json({ error: 'invalid', message: problem });

      const existing = await store.userCount();
      if (existing > 0) {
        if (!inviteCode) {
          return res.status(403).json({
            error: 'closed',
            message: '這台伺服器已經有帳號了，不開放註冊。' +
              '要再開一個的話，請在伺服器的 .env 設定 INVITE_CODE 再重新啟動。',
          });
        }
        if (String(given ?? '') !== inviteCode) {
          return res.status(403).json({ error: 'bad_invite', message: '邀請碼不對。' });
        }
      }

      const user = await store.createUser(username, await hashPassword(password));
      const { token, expiresAt } = await store.createSession(user.id);
      res.setHeader('Set-Cookie', cookieFor(req, token, expiresAt));
      res.status(201).json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  // ─── 登入 ──────────────────────────────────────────────────────────────
  router.post('/login', async (req, res, next) => {
    try {
      const { username, password } = req.body ?? {};
      const key = `${String(username ?? '').toLowerCase()}|${req.ip}`;

      const wait = gate.retryAfter(key);
      if (wait > 0) {
        res.setHeader('Retry-After', Math.ceil(wait / 1000));
        return res.status(429).json({
          error: 'too_many',
          message: `密碼連續錯太多次了，請 ${Math.ceil(wait / 1000)} 秒後再試。`,
        });
      }

      const user = await store.findUser(username ?? '');
      const ok = user ? await verifyPassword(String(password ?? ''), user.passwordHash) : false;

      if (!ok) {
        gate.fail(key);
        // 帳號不存在與密碼錯給同一句話 —— 分開講等於告訴人家哪些帳號存在
        return res.status(401).json({ error: 'bad_login', message: '帳號或密碼不對。' });
      }

      gate.succeed(key);
      const { token, expiresAt } = await store.createSession(user.id);
      res.setHeader('Set-Cookie', cookieFor(req, token, expiresAt));
      res.json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      await store.deleteSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', {
        clear: true, secure: isSecureRequest(req),
      }));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // 前端啟動時先問這個：401 就顯示登入畫面，其他就照常進 App
  router.get('/me', async (req, res, next) => {
    try {
      const user = await store.userForToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      if (!user) {
        return res.status(401).json({
          error: 'unauthenticated',
          // 前端要用這個決定登入畫面上是「登入」還是「建立第一個帳號」
          canRegister: (await store.userCount()) === 0 || Boolean(inviteCode),
          firstRun: (await store.userCount()) === 0,
        });
      }
      res.json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });


  return router;
}

/**
 * 登入關卡 + CSRF。掛在所有 `/api` 之前。
 *
 * 順序有意義：先擋沒登入的，再檢查 Origin —— 反過來的話，
 * 沒登入的人送一個怪 Origin 會拿到 403 而不是 401，訊息對不上實際情況。
 */
export function createAuthGate(store) {
  return async function authGate(req, res, next) {
    try {
      // ⚠ 用 baseUrl + path，不要用 req.path。
      //
      // 這個中介層是掛在 `/api` 上的，而 express 會把掛載路徑從 `req.path`
      // 剝掉 —— `/api/health` 進到這裡時 `req.path` 是 `/health`，
      // 用它比對就會把 healthcheck 也擋掉。症狀是容器一直 unhealthy、
      // 或啟動腳本的「等 /api/health」永遠等不到（真的踩過）。
      if (isPublicPath(req.baseUrl + req.path)) return next();

      const user = await store.userForToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      if (!user) {
        return res.status(401).json({
          error: 'unauthenticated',
          message: '請先登入。',
        });
      }

      // 改變狀態的請求才檢查 Origin。GET 不檢查 —— 跨站的 GET 本來就讀不到回應
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const host = req.headers['x-forwarded-host'] ?? req.headers.host;
        if (!originAllowed(req.headers.origin, host)) {
          return res.status(403).json({
            error: 'bad_origin',
            message: '請求的來源不對，已擋下（防跨站偽造請求）。',
          });
        }
      }

      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * 同步端點。
 *
 *   GET  /api/sync         整包下載
 *   PUT  /api/sync         整包上傳（rev 樂觀鎖）—— 覆蓋，需要使用者確認
 *   POST /api/sync/merge   合併（階段 B，自動同步走這條）
 *
 * 資料的形狀就是前端匯出檔的 `data`（`BACKUP_KEYS` 那五個鍵），
 * 所以伺服器不必另外定義一套格式，前端也能重用 `lib/backup.js` 的檢查。
 */
export function createSyncRoutes(store) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      res.json(await store.readData(req.user.id));
    } catch (err) {
      next(err);
    }
  });

  /**
   * 收進來的 `data` 檢查 + 白名單。回 `{ clean }` 或 `{ error }`。
   *
   * 白名單是刻意的：不擋的話前端塞什麼進來伺服器就存什麼，
   * 而那些東西會在同步時被寫回每一台裝置的 localStorage。
   */
  function cleanIncoming(data, { allowEmpty = false } = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { error: { status: 400, error: 'bad_data', message: 'data 必須是物件。' } };
    }

    const clean = {};
    for (const key of SYNC_KEYS) {
      if (data[key] !== undefined) clean[key] = data[key];
    }
    if (Object.keys(clean).length === 0 && !allowEmpty) {
      // PUT 是整包覆蓋 —— 空的送上去等於把伺服器清空，那幾乎一定是誤觸。
      // **合併不一樣**：一台還沒練過任何東西的新裝置本來就沒東西可送，
      // 而它正是最需要同步的那一台（登入之後要把全部拉下來）。
      return {
        error: {
          status: 400, error: 'empty_data',
          message: '這份資料裡沒有任何認得的進度，沒有上傳。',
        },
      };
    }

    const size = Buffer.byteLength(JSON.stringify(clean));
    if (size > MAX_DATA_BYTES) {
      return {
        error: {
          status: 413, error: 'too_large',
          message: `進度資料太大了（${(size / 1024 / 1024).toFixed(1)} MB，` +
            `上限 ${MAX_DATA_BYTES / 1024 / 1024} MB）。`,
        },
      };
    }
    return { clean };
  }

  router.put('/', async (req, res, next) => {
    try {
      const { rev, data } = req.body ?? {};

      if (!Number.isInteger(rev) || rev < 0) {
        return res.status(400).json({ error: 'bad_rev', message: 'rev 必須是非負整數。' });
      }

      const { clean, error } = cleanIncoming(data);
      if (error) return res.status(error.status).json(error);

      const next_ = await store.writeData(req.user.id, clean, rev);
      res.json({ rev: next_.rev, updatedAt: next_.updatedAt });
    } catch (err) {
      if (err instanceof StoreError && err.httpStatus === 409) {
        // 409 要把目前的整包帶回去，前端才有東西可以比對／合併，
        // 不必再多打一次 GET
        return res.status(409).json({
          error: 'conflict',
          message: err.userMessage,
          current: err.current,
        });
      }
      next(err);
    }
  });

  /**
   * 合併：把這台裝置的整份進度送上來，跟伺服器上那份合成一份，寫回去，
   * 再把**合併後的結果**回給前端套用。
   *
   * 為什麼合併在伺服器端做，而不是前端 GET → 合 → PUT：
   *   1. **原子性** —— 合併與寫入在 store 的同一個獨佔區段裡完成，
   *      不會出現「讀完之後另一台先寫進去」而要重試的 409 迴圈；
   *   2. 伺服器上永遠是合併後的真相，不必倚賴某一台裝置有沒有跑完流程。
   *
   * 而規則本身是**跟前端共用的那一份純函式**，所以「合併在哪裡做」
   * 不影響結果，也不會有兩份實作分岔的問題。
   *
   * 這裡**不做樂觀鎖**：合併本身是冪等且滿足交換律的（`lib/merge.js` 的
   * 兩條性質），所以「讀到的 rev 過期了」不會造成任何損失 ——
   * 就是再合一次而已，結果一樣。
   */
  router.post('/merge', async (req, res, next) => {
    try {
      // allowEmpty：剛登入的新裝置沒有任何進度，而它正是最需要同步的那一台
      const { clean, error } = cleanIncoming(req.body?.data, { allowEmpty: true });
      if (error) return res.status(error.status).json(error);

      const result = await store.mergeData(req.user.id, (current) => mergeState(current, clean));
      res.json({ rev: result.rev, updatedAt: result.updatedAt, data: result.data });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
