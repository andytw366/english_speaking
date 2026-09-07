// 版面盤點：七個模式 × 三種螢幕，量「用掉多少寬度、要捲幾個螢幕」，順便存截圖。
//
// **這不是測試，是尺**（沒有斷言，永遠不會紅）。版面的問題沒辦法用斷言釘住 ——
// 「桌機上只用了 47% 的寬度」不是壞掉，是浪費，而浪費要看數字才看得出來。
// 改版之前先跑一次留底，改完再跑一次比對，才知道哪一頁真的變好了。
//
//   npm start            # 另一個終端機（不用設任何金鑰）
//   npm run test:layout
//
// 環境變數：BASE、SHOTS（存截圖的目錄，不設就只印數字）、CHROMIUM。
//
// 2026-09 改版前的基準（1440×900）：七個模式一律 680px 寬（47%），
// 跟讀要捲 2.0 個螢幕、設定 3.3 個。
import { chromium } from '@playwright/test';
import { addCookieToContext, apiGetter, authenticate } from './login.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const OUT = process.env.SHOTS;

// 要先登入 —— 題庫端點也要（見 server/routes-auth.js）。
// 少了這一段，`/api/content/sentences` 回的是 401 的 JSON 物件，
// 而下面那句會印「伺服器有在跑嗎」，把人往完全錯的方向帶（真的發生過）。
const cookieHeader = await authenticate(BASE);
const apiGet = apiGetter(BASE, cookieHeader);

const sentences = await apiGet('/api/content/sentences').catch(() => null);
if (!Array.isArray(sentences)) {
  console.error(
    `讀不到練習句（拿到的是 ${JSON.stringify(sentences)?.slice(0, 120)}）。\n` +
    `${BASE} 上的伺服器有在跑嗎？`
  );
  process.exit(1);
}
const noonDaysAgo = (d) => { const x = new Date(); x.setDate(x.getDate() - d); x.setHours(12, 0, 0, 0); return x.toISOString(); };
const history = [[0, 88, 0, 'th'], [1, 72, 1, 'r_l'], [2, 91, 2], [3, 65, 3, 'v_w'], [4, 79, 4], [5, 84, 6]]
  .map(([i, score, days = 0, issue = null]) => {
    const s = sentences[i % sentences.length];
    return { at: noonDaysAgo(days), sentenceId: s.id, sentenceText: s.text, category: s.category,
      difficulty: s.difficulty, score, provider: 'azure', transcript: s.text,
      problemWords: issue ? [{ word: s.text.split(' ')[0], issue, heard: '', tip_zh: '' }] : [] };
  });
const today = new Date(); const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const activity = { vocabulary: { [key]: 12 }, shadowing: { [key]: 3 }, listening: { [key]: 2 }, translation: { [key]: 1 }, dialogue: { [key]: 4 } };
const srs = Object.fromEntries([...Array(30)].map((_, i) => [`ecdict:${i + 1}`, { box: (i % 4) + 1, due: noonDaysAgo(1), seen: 3 }]));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const ctx = await browser.newContext();
await addCookieToContext(ctx, BASE, cookieHeader);   // 不塞的話量到的是登入畫面的版面
const page = await ctx.newPage();
await page.goto(BASE);
await page.evaluate(({ h, r, a }) => {
  localStorage.setItem('speaking-coach:history', JSON.stringify(h));
  localStorage.setItem('speaking-coach:srs', JSON.stringify(r));
  localStorage.setItem('speaking-coach:activity', JSON.stringify(a));
  localStorage.setItem('speaking-coach:settings', JSON.stringify({ vocabDeck: 'tier-1', vocabQuizTypes: ['en2zh'] }));
}, { h: history, r: srs, a: activity });

const MODES = ['home', 'vocabulary', 'listening', 'translation', 'dialogue', 'shadowing', 'settings'];
const SIZES = [['desktop', 1440, 900], ['laptop', 1280, 800], ['mobile', 390, 844]];

for (const [name, w, hgt] of SIZES) {
  await page.setViewportSize({ width: w, height: hgt });
  for (const mode of MODES) {
    await page.evaluate((m) => localStorage.setItem('speaking-coach:mode', m), mode);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#view .card, #view .banner', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(900);
    const m = await page.evaluate(() => ({
      pageH: document.documentElement.scrollHeight,
      viewH: window.innerHeight,
      // 量的是內容本身（#view），不是外層的欄 —— 外層可能留白給輔助欄
    appW: document.getElementById('view').getBoundingClientRect().width,
      winW: window.innerWidth,
      cards: document.querySelectorAll('#view .card').length,
    }));
    console.log(`${name.padEnd(8)} ${mode.padEnd(11)} 內容高 ${String(m.pageH).padStart(5)}px / 視窗 ${m.viewH}px = ${(m.pageH / m.viewH).toFixed(1)} 螢幕・內容寬 ${Math.round(m.appW)} / ${m.winW}px（用掉 ${Math.round(m.appW / m.winW * 100)}%）・卡片 ${m.cards}`);
    if (OUT) await page.screenshot({ path: `${OUT}/${name}-${mode}.png`, fullPage: name !== 'desktop' });
  }
  console.log('');
}
await browser.close();
