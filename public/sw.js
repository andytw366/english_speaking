// Service worker：讓這個 App 可以加到手機主畫面、而且沒有網路也打得開。
//
// 三條規則，各自對應一種東西（`strategyFor()` 是唯一決定用哪一條的地方）：
//
//   shell    App 本身（HTML / CSS / JS / 圖示）與題庫（/api/content、/api/vocabulary）
//            → **先給快取、同時去要新的**（stale-while-revalidate）
//   navigate 換頁 → **先連網路**，斷線才給快取的首頁
//   network  其他 /api/*（金鑰設定、發音評估、health）→ **完全不碰快取**
//
// **為什麼 shell 是 stale-while-revalidate 而不是 cache-first。** cache-first 加一個
// 版本號常數是最常見的寫法，也是最常見的坑：改完程式忘了改版本號，使用者的瀏覽器
// 就永遠停在舊版，而且完全沒有徵兆（重新整理也一樣，因為快取先回答了）。
// SWR 一樣是秒開，但每次都會在背景抓一份新的回來，下次打開就是新的 —— 最壞情況是
// 「慢一次載入」，不是「永遠不會更新」。
//
// **`/api/settings` 與 `/api/pronunciation-feedback` 絕對不能進快取**：一個是金鑰
// （存進快取等於把金鑰多寫一份到硬碟上），一個是每次都不一樣的評分結果。
// `test/pwa.test.js` 有一條釘住這件事。
//
// 版本號只用來「換掉整批舊快取」（例如格式改了），不是拿來當更新的開關。

const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = `data-${VERSION}`;

/**
 * 安裝時就抓下來的檔案 —— 少一個的症狀是「離線時某個模式打不開」。
 *
 * **新增 public/ 底下的 .js / .css 時要加進來**，`test/pwa.test.js` 會掃過
 * public/ 目錄比對，漏了就紅。
 */
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-32.png',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/lib/azure-issues.js',
  '/lib/backup.js',
  '/lib/daily.js',
  '/lib/dom.js',
  '/lib/grade.js',
  '/lib/keys.js',
  '/lib/labels.js',
  '/lib/login-view.js',
  '/lib/layout.js',
  '/lib/modes.js',
  '/lib/practice.js',
  '/lib/quiz.js',
  '/lib/recorder.js',
  '/lib/session.js',
  '/lib/settings.js',
  '/lib/stat-tile.js',
  '/lib/storage.js',
  '/lib/sync.js',
  '/lib/text-diff.js',
  '/lib/today-card.js',
  '/lib/trend-chart.js',
  '/lib/tts.js',
  '/lib/wav-encoder.js',
  '/lib/waveform.js',
  '/modes/assessment-view.js',
  '/modes/dialogue.js',
  '/modes/home.js',
  '/modes/listening.js',
  '/modes/settings.js',
  '/modes/shadowing-views.js',
  '/modes/shadowing.js',
  '/modes/translation.js',
  '/modes/vocabulary.js',
];

/** 題庫：離線也要練得起來，但太大不適合一開始就全抓（六個分級檔就 3 MB）。 */
const DATA_PREFIXES = ['/api/content/', '/api/vocabulary/'];

/**
 * 這個網址要用哪一條規則。純函式，所以測試跑得到（見 `test/pwa.test.js`）。
 *
 * @param {URL} url
 * @param {string} mode `request.mode`，換頁是 `'navigate'`
 * @returns {'navigate'|'shell'|'data'|'auth-probe'|'network'}
 */
function strategyFor(url, mode = '') {
  if (url.origin !== self.location.origin) return 'network';
  if (mode === 'navigate') return 'navigate';
  if (DATA_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return 'data';
  // App 一啟動就問「現在是誰」。離線時這個請求一定失敗，而 console 會因此
  // 留下一筆紅色錯誤 —— 那會淹掉真正的錯誤（`test/ui.mjs`【20】在抓）。
  // 所以離線時由 service worker 直接回一個 **200** 的「問不到」。
  //
  // 為什麼一定要 200：瀏覽器對**網路失敗**與 **4xx/5xx** 都會記一筆
  // 「Failed to load resource」。先改成 503 還是紅（CI 上實測過），
  // 只有 2xx 才真的安靜。
  //
  // **不要改用 `navigator.onLine` 判斷。** 那個值在某些 Chromium 版本下
  // 不會跟著離線變成 false（CI 的版本就是），防護會安靜地失效。
  if (url.pathname === '/api/auth/me') return 'auth-probe';
  // 其餘的 /api/* 一律不碰快取（金鑰、發音評估、health、登入登出）
  if (url.pathname.startsWith('/api/')) return 'network';
  return 'shell';
}
// 給測試用（正常執行時沒有人讀這兩個）。service worker 沒辦法在 node 裡真的跑
// 起來，所以規則本身寫成純函式，`test/pwa.test.js` 用 node:vm 載進來直接呼叫。
self.__strategyFor = strategyFor;
self.__swExports = { SHELL, DATA_PREFIXES, VERSION };

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 一個檔案失敗不該讓整個安裝失敗（addAll 是全有全無）——
    // 少一個檔案只是那一頁離線時打不開，比整個 SW 裝不起來好
    await Promise.all(SHELL.map((path) => cache.add(path).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, DATA_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const strategy = strategyFor(new URL(request.url), request.mode);
  if (strategy === 'network') return;

  if (strategy === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  if (strategy === 'auth-probe') {
    event.respondWith(authProbe(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(
    request,
    strategy === 'data' ? DATA_CACHE : SHELL_CACHE,
  ));
});

/** 換頁：先連網路，斷線才給快取的首頁（不然改版之後會一直開到舊的 HTML）。 */
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put('/index.html', response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match('/index.html') ?? await cache.match('/');
    if (cached) return cached;
    throw err;
  }
}

/**
 * 「現在是誰」：**完全不快取**，只是把連不上的情況換成一個「問不到」的回應。
 *
 * 為什麼不直接放給瀏覽器處理：失敗的請求會在 console 留下紅色錯誤，
 * 而離線本來就是預期中的狀態，不該長得像出事了。
 *
 * ⚠️ **狀態碼一定要是 200。** 瀏覽器對網路失敗與 4xx/5xx 都會記一筆
 * 「Failed to load resource」—— 先寫成 503，CI 上照樣紅。真正安靜的只有 2xx，
 * 所以「問不到」是寫在 body 裡的旗標而不是狀態碼。
 *
 * `lib/session.js` 的 `whoAmI()` 看到 `offline: true` 就知道這不是
 * 「沒登入」而是「問不到」，App 照常開啟（題庫在快取裡、進度在 localStorage 裡）。
 */
async function authProbe(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(JSON.stringify({ offline: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
}

/** 先給快取（秒開），同時在背景抓一份新的存起來，下次就是新的。 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fresh = fetch(request).then((response) => {
    // 只存成功的回應：把 404 或 500 存起來的話，之後就一直拿到那個錯誤
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch((err) => {
    if (cached) return cached;
    throw err;
  });

  return cached ?? fresh;
}
