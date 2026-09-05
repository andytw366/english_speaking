// 產生 PWA 用的圖示（一次性，產物 committed 進 repo）。
//
//   node scripts/build-icons.mjs
//
// **為什麼用瀏覽器畫而不是找一個圖片套件**：這個 repo 的正式相依只有伺服器要用的
// 四個套件，為了畫四張 PNG 再加一個影像套件不划算；而 Playwright 的 Chromium
// 本來就在 devDependencies 裡（前端測試要用），拿它把一段 SVG 截圖成 PNG 最省。
//
// **產物要 commit**：使用者跑 npm start 之前不會先跑這支腳本，
// 而 manifest 少了圖示的話「加到主畫面」會拿不到圖。
//
// 設計：品牌藍的圓角方塊 + 白色的「英」。
// - 一眼認得出是哪個 App（桌面上一排圖示裡不能只是個漸層方塊）
// - maskable 版本留 20% 安全邊界 —— Android 會把圖示裁成圓形／水滴形，
//   邊界不夠的話「英」會被切掉半個字

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const OUT = path.join(import.meta.dirname, '..', 'public', 'icons');
const ACCENT = '#2f6feb';

/** @param {number} pad 內縮的比例（maskable 要留安全邊界） */
const svg = (size, pad = 0) => {
  const inset = size * pad;
  const box = size - inset * 2;
  const radius = box * (pad > 0 ? 0.5 : 0.22);   // maskable 直接畫成圓形，裁切怎麼切都不會缺角
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${pad > 0 ? ACCENT : 'none'}"/>
  <rect x="${inset}" y="${inset}" width="${box}" height="${box}" rx="${radius}" fill="${ACCENT}"/>
  <text x="50%" y="50%" dy="0.02em" text-anchor="middle" dominant-baseline="central"
        font-size="${box * 0.62}" font-weight="700" fill="#ffffff"
        font-family="'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif">英</text>
</svg>`;
};

const TARGETS = [
  { file: 'icon-32.png', size: 32, pad: 0 },
  { file: 'icon-180.png', size: 180, pad: 0 },     // iOS 的 apple-touch-icon
  { file: 'icon-192.png', size: 192, pad: 0 },
  { file: 'icon-512.png', size: 512, pad: 0 },
  { file: 'icon-maskable-512.png', size: 512, pad: 0.2 },
];

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage();

for (const { file, size, pad } of TARGETS) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;padding:0}</style>${svg(size, pad)}`,
    { waitUntil: 'load' },
  );
  // omitBackground：不留白底，圓角外面要是透明的
  await page.screenshot({ path: path.join(OUT, file), omitBackground: true });
  console.log(`${file}  ${size}×${size}${pad ? '（maskable）' : ''}`);
}

await browser.close();
