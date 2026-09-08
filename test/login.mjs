// 三支瀏覽器測試（ui / e2e / layout）共用的登入。
//
// 為什麼要抽出來：所有 `/api` 端點都要登入（見 server/routes-auth.js），
// 而漏帶 cookie 的症狀**看起來完全不像沒登入** —— 拿到的是 401 的 JSON 物件
// 而不是預期的陣列（`.find is not a function`），或者瀏覽器停在登入畫面、
// 每一條檢查都紅。`test/e2e.mjs` 與 `test/layout.mjs` 就是這樣**從帳號上線之後
// 一直跑不動**，而 layout 印的是「伺服器有在跑嗎？」，把人往完全錯的方向帶。
// 一份共用的話，下一次動門禁時只有一個地方要改。
//
// 「先註冊，失敗就改成登入」是為了兩種情境都能跑：
//   CI     每次都是全新的容器 → 沒有帳號 → 註冊成功（那個帳號就是擁有者）
//   本機   重跑第二次時帳號已經在了 → 註冊被拒 → 用同一組密碼登入
// 需要伺服器指向一個乾淨的 DATA_DIR 才會是「第一個帳號」，所以這組帳密
// 只會出現在開發／CI 的伺服器上。

export const TEST_USER = { username: 'uitest', password: 'ui-test-password' };

/**
 * 登入（必要時先註冊），回一個可以直接用的 cookie 字串。
 *
 * 失敗就 `process.exit(1)` 並印出該怎麼辦 —— 呼叫端都是「跑起來給人看」的
 * 腳本，不是 assert 型的測試，把錯誤往上丟只會變成一個沒人看得懂的 stack。
 *
 * @param {string} base 伺服器網址，例如 http://localhost:3000
 * @returns {Promise<string>} `sc_session=…`
 */
export async function authenticate(base) {
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  let res;
  try {
    res = await post('/api/auth/register', TEST_USER);
    if (!res.ok) res = await post('/api/auth/login', TEST_USER);
  } catch (err) {
    console.error(`連不上 ${base} —— 伺服器有在跑嗎？（npm start）\n${err.message}`);
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error(
      `測試帳號登入不了（HTTP ${res.status}）：${body.message ?? ''}\n` +
      '這台伺服器上已經有別的帳號了。請用一個乾淨的 DATA_DIR 重新啟動伺服器：\n' +
      '  DATA_DIR=$(mktemp -d) npm start'
    );
    process.exit(1);
  }

  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

/**
 * 把 cookie 塞進 Playwright 的 context，其餘的測試就不必管登入。
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} base
 * @param {string} cookieHeader `authenticate()` 的回傳值
 */
export async function addCookieToContext(context, base, cookieHeader) {
  const { hostname } = new URL(base);
  await context.addCookies(cookieHeader.split('; ').map((pair) => {
    const [name, ...rest] = pair.split('=');
    return {
      name, value: rest.join('='), domain: hostname, path: '/',
      httpOnly: true, secure: false,
    };
  }));
}

/** 帶 cookie 的 GET。回 JSON。 */
export function apiGetter(base, cookieHeader) {
  return (path) =>
    fetch(`${base}${path}`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
}

/**
 * 把這個測試帳號在**伺服器上**的進度清成「什麼都沒練過」。
 *
 * 為什麼瀏覽器測試需要這個：清掉 localStorage 不夠 —— 自動同步（階段 B）會在
 * App 一打開時把伺服器上那份合併回這台裝置，所以「新裝置上什麼都還沒練」
 * 這個前提會被上一次跑測試留下的紀錄打破。症狀是好幾條斷言同時說數字不對，
 * 看起來像合併寫錯了，其實是測試自己的殘留（`test/e2e.mjs` 真的踩過：
 * 「今天的進度是 0」在同一個 DATA_DIR 上重跑第二次就開始紅）。
 *
 * 走的是「整包覆蓋」那個端點 —— 它就是為了覆蓋而存在的，
 * 而 `POST /sync/merge` 的語意是合併，清不掉東西。
 */
export async function resetServerProgress(base, cookieHeader) {
  const current = await fetch(`${base}/api/sync`, { headers: { cookie: cookieHeader } })
    .then((r) => r.json());
  const res = await fetch(`${base}/api/sync`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({
      rev: current.rev ?? 0,
      data: { srs: {}, activity: {}, history: [] },
    }),
  });
  if (!res.ok) {
    console.error(`清不掉伺服器上的進度（HTTP ${res.status}）—— 絕對數字的斷言會不準。`);
    process.exit(1);
  }
}
