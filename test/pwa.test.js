// PWA 的三個檔案：manifest、圖示、service worker。
//
// 這裡釘的是**壞掉不會有任何徵兆**的那幾件事：
//
//   1. service worker 的快取清單漏掉一個檔案 → 那個模式離線時打不開，
//      而有網路的時候完全看不出來
//   2. 金鑰或發音評估的回應被存進快取 → 金鑰多寫一份到硬碟上，
//      而且評分結果會拿到上一次的
//   3. manifest 指到不存在的圖示 → 「加到主畫面」拿不到圖，
//      但瀏覽器不會報錯，只是圖示變成一個灰方塊
//
// service worker 沒辦法在 node 裡真的跑起來（沒有 caches、Request、Response），
// 所以把「哪個網址用哪一條規則」寫成純函式 `strategyFor()`，這裡用 node:vm
// 把 sw.js 載進來直接呼叫它 —— 驗的是規則本身，不是瀏覽器的實作。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));

/** 把 sw.js 載進一個假的 worker 環境，回傳它掛在 self 上的東西。 */
function loadServiceWorker() {
  const self = {
    location: new URL('http://localhost:3000/sw.js'),
    addEventListener() {},
    skipWaiting() {},
    clients: { claim() {} },
  };
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8'), { self, URL, console });
  return self;
}

/** PNG 的寬高就在檔頭：8 bytes 簽章 + 長度 + 'IHDR' 之後的兩個 32-bit 大端整數。 */
function pngSize(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', `${file} 不是 PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** public/ 底下所有前端會載入的檔案（sw.js 自己不算，它不能快取自己）。 */
function frontendAssets(dir = PUBLIC, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...frontendAssets(path.join(dir, entry.name), rel));
    else if (/\.(js|css)$/.test(entry.name) && rel !== '/sw.js') out.push(rel);
  }
  return out;
}

// ─── 快取清單 ────────────────────────────────────────────────────────────

test('service worker 的快取清單涵蓋 public/ 裡的每一個 js 與 css', () => {
  const { SHELL } = loadServiceWorker().__swExports;
  const listed = new Set(SHELL);

  for (const asset of frontendAssets()) {
    assert.ok(listed.has(asset),
      `${asset} 不在 sw.js 的 SHELL 裡 —— 離線時用到它的模式會打不開`);
  }
});

test('快取清單裡沒有已經不存在的檔案', () => {
  const { SHELL } = loadServiceWorker().__swExports;
  for (const entry of SHELL) {
    if (entry === '/') continue;                       // 首頁本身
    assert.ok(fs.existsSync(path.join(PUBLIC, entry)), `${entry} 在 SHELL 裡但檔案不存在`);
  }
});

// ─── 哪個網址用哪一條規則 ────────────────────────────────────────────────

test('App 自己的檔案先給快取（stale-while-revalidate）', () => {
  const { __strategyFor: strategyFor } = loadServiceWorker();
  for (const p of ['/style.css', '/app.js', '/lib/quiz.js', '/icons/icon-192.png']) {
    assert.equal(strategyFor(new URL(`http://localhost:3000${p}`)), 'shell', p);
  }
});

test('題庫可以離線用，但走另一個快取（它比 App 本身大得多）', () => {
  const { __strategyFor: strategyFor } = loadServiceWorker();
  assert.equal(strategyFor(new URL('http://localhost:3000/api/content/sentences')), 'data');
  assert.equal(strategyFor(new URL('http://localhost:3000/api/vocabulary/tier-1.json')), 'data');
});

test('金鑰與發音評估絕對不進快取', () => {
  const { __strategyFor: strategyFor } = loadServiceWorker();
  // /api/settings 存進快取等於把金鑰多寫一份到硬碟上；
  // 發音評估每次的結果都不一樣，拿到上一次的比沒有還糟
  for (const p of ['/api/settings', '/api/pronunciation-feedback', '/api/health', '/api/models']) {
    assert.equal(strategyFor(new URL(`http://localhost:3000${p}`)), 'network', p);
  }
});

test('換頁先連網路（不然改版之後會一直開到舊的 HTML）', () => {
  const { __strategyFor: strategyFor } = loadServiceWorker();
  assert.equal(strategyFor(new URL('http://localhost:3000/'), 'navigate'), 'navigate');
});

test('別人家的網址一律不碰', () => {
  const { __strategyFor: strategyFor } = loadServiceWorker();
  assert.equal(strategyFor(new URL('https://generativelanguage.googleapis.com/x')), 'network');
});

// ─── manifest 與圖示 ─────────────────────────────────────────────────────

test('manifest 該有的欄位都在', () => {
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.ok(manifest.name && manifest.short_name);
  // short_name 是主畫面上圖示底下那行字，太長會被截掉
  assert.ok(manifest.short_name.length <= 12, manifest.short_name);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
});

test('manifest 指到的圖示都存在，而且尺寸跟宣告的一致', () => {
  for (const icon of manifest.icons) {
    const file = path.join(PUBLIC, icon.src);
    assert.ok(fs.existsSync(file), `${icon.src} 不存在`);
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.deepEqual(pngSize(file), { width: w, height: h }, icon.src);
  }
});

test('有一張 maskable 圖示 —— Android 會把圖示裁成圓形', () => {
  const maskable = manifest.icons.filter((i) => i.purpose === 'maskable');
  assert.ok(maskable.length >= 1, '沒有 maskable 的話，圖示的四個角會被裁掉');
  assert.ok(maskable.every((i) => Number(i.sizes.split('x')[0]) >= 512));
});

test('index.html 有接上 manifest、圖示與 iOS 的那幾行', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /rel="manifest"/);
  // 這一行同時是「favicon 404」的解 —— 沒有它 console 會一直有一筆 404
  assert.match(html, /rel="icon"/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /name="theme-color"/);
  // viewport-fit=cover：iPhone 上下方的模式列要貼到底（配合 safe-area-inset）
  assert.match(html, /viewport-fit=cover/);
});
