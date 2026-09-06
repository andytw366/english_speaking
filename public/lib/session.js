// 登入狀態與「打 API」的共用出入口。
//
// 為什麼所有 API 都要走這裡：session 會過期（30 天），而過期之後每一個
// 請求都會回 401。散在各處各自 `fetch()` 的話，使用者看到的會是六個模式
// 各自的錯誤訊息（「讀取聽力題失敗（HTTP 401）」），沒有人會知道
// 那其實是「要重新登入」。集中在這裡，401 就能一次處理掉。

/** 目前登入的人。null = 沒登入。 */
let currentUser = null;

/** 401 的時候要通知誰（app.js 註冊，用來把畫面切回登入）。 */
let onUnauthenticated = null;

export function setUnauthenticatedHandler(fn) {
  onUnauthenticated = fn;
}

export function getUser() {
  return currentUser;
}

/** API 回了非 2xx 時丟這個。`status` 讓呼叫端分辨 401 與其他。 */
export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * 打 API。非 2xx 一律丟 `ApiError`，401 順便通知外殼切回登入畫面。
 *
 * `credentials: 'same-origin'` 是預設值，這裡寫出來是為了講清楚
 * **身分是靠 cookie 帶的**，前端拿不到也存不到那個 token（HttpOnly）。
 */
export async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, {
    method,
    signal,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401) {
    currentUser = null;
    // 只有「本來以為登入著」才需要把畫面切走；登入畫面自己打 /me 拿到 401
    // 是預期中的事，不該再觸發一次切換
    onUnauthenticated?.();
  }

  if (res.status === 204) return null;

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // 非 JSON 的回應（例如代理丟出來的 502 HTML）
  }

  if (!res.ok) {
    throw new ApiError(res.status, payload?.message ?? `請求失敗（HTTP ${res.status}）`, payload);
  }
  return payload;
}

/**
 * 現在是誰。
 *
 * @returns {Promise<{user: object|null, firstRun: boolean, canRegister: boolean}>}
 *   `firstRun` = 這台伺服器一個帳號都還沒有 → 登入畫面要顯示「建立第一個帳號」
 */
export async function whoAmI() {
  const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
  let payload = null;
  try {
    payload = await res.json();
  } catch { /* 忽略 */ }

  if (res.ok && payload?.user) {
    currentUser = payload.user;
    return { user: payload.user, firstRun: false, canRegister: false };
  }

  // **401 與「問不到」是兩件事，一定要分開。**
  //   401  伺服器明確說你沒登入 → 顯示登入畫面
  //   其他 連不到／伺服器出問題（離線時 service worker 會給 503）
  //        → 丟出去，呼叫端照常開啟 App
  // 混在一起的話，離線打開 App 會被推到登入畫面 —— 而那時候根本登入不了，
  // 等於離線就不能練，PWA 的重點就沒了
  if (res.status !== 401) {
    throw new ApiError(res.status, payload?.message ?? `問不到登入狀態（HTTP ${res.status}）`, payload);
  }

  currentUser = null;
  return {
    user: null,
    firstRun: Boolean(payload?.firstRun),
    canRegister: Boolean(payload?.canRegister),
  };
}

export async function login(username, password) {
  const { user } = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  currentUser = user;
  return user;
}

export async function register(username, password, inviteCode) {
  const { user } = await api('/api/auth/register', {
    method: 'POST',
    body: { username, password, inviteCode },
  });
  currentUser = user;
  return user;
}

/**
 * 登出。**題庫的快取要一起清掉** —— 那是登入才拿得到的東西，
 * 留在裝置上等於換一個人來也照樣看得到（而且下一個人登入後會先吃到舊的）。
 *
 * 學習進度（localStorage）**刻意不清**：那是這台裝置上的資料，
 * 使用者登出不代表要放棄它，而且清掉的話再登入就得整包從伺服器抓回來。
 */
export async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } finally {
    currentUser = null;
    try {
      const names = await caches?.keys?.() ?? [];
      await Promise.all(names.filter((n) => n.startsWith('data-')).map((n) => caches.delete(n)));
    } catch {
      // 快取清不掉不該讓登出失敗
    }
  }
}
