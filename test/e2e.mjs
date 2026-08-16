// 瀏覽器端對端測試（Playwright + headless Chromium）。
//
// 跟 audio.test.js 不同，這支**需要伺服器在跑，也會真的呼叫 Gemini API**，
// 所以不放進 `npm test`。單獨執行：
//
//   npm start                       # 另一個終端機，或用 BASE 指到別的埠
//   npm run test:e2e
//
// 可用的環境變數：
//   BASE   受測網址，預設 http://localhost:3000
//   MODEL  送出時選的 model，預設 gemini-3.1-flash-lite
//          （最快也最省配額；免費層很容易把 flash 系列打到 429）
//   SHOTS  設成一個目錄路徑就會在各步驟存下截圖
//
// 錄音怎麼測的：Chromium 的 --use-file-for-fake-audio-capture 可以把一個 WAV
// 檔當成麥克風輸入。這裡餵的是 fixtures/speech-16k.wav（真實語音），
// 所以整條路徑 —— getUserMedia → MediaRecorder → 轉 WAV → 能量檢查 →
// 上傳 → Gemini → 顯示講評 → 寫進 localStorage —— 都是真的在跑，沒有假資料。
//
// WSL note：headless 模式在 WSL2 可以直接跑，不需要 X server 或 WSLg。

import { chromium } from '@playwright/test';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const MODEL = process.env.MODEL ?? 'gemini-3.1-flash-lite';
const SHOTS = process.env.SHOTS;
const AUDIO = path.resolve('test/fixtures/speech-16k.wav');

const errors = [];
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : '*** FAIL ***'}  ${name}${extra ? '  → ' + extra : ''}`);
  if (!ok) failed++;
};
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : null);

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${AUDIO}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({ permissions: ['microphone'] });
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

console.log(`\n受測網址 ${BASE}，送出時使用 ${MODEL}`);

console.log('\n【1】頁面載入與初始狀態');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !document.getElementById('sentence').textContent.includes('載入中'));
check('例句載入', !(await page.textContent('#sentence')).includes('載入中'), await page.textContent('#sentence'));
check('沒有 fatal 橫幅', await page.locator('#fatal').isHidden());
check('情境選單有選項', (await page.locator('#filter-category option').count()) >= 2);
check('難度選單有選項', (await page.locator('#filter-difficulty option').count()) >= 2);
check('句數統計有顯示', /符合條件 \d+ \/ \d+ 句/.test(await page.textContent('#filter-count')));
// 這幾項在意的是 CSS 有沒有蓋掉 hidden 屬性 —— .playback{display:flex} 之類的
// 規則會讓 <div hidden> 照樣顯示出來，所以要用實際可見性判斷而不是看屬性。
check('練習紀錄一開始是隱藏的', await page.locator('#history-card').isHidden());
check('錄音區塊一開始是隱藏的', await page.locator('#playback').isHidden());
check('波形一開始是隱藏的', await page.locator('#waveform').isHidden());
check('音量條一開始是隱藏的', await page.locator('#level').isHidden());
check('講評卡片一開始是隱藏的', await page.locator('#feedback-card').isHidden());
await shot(page, '01-初始');

console.log('\n【2】篩選');
const total = Number((await page.textContent('#filter-count')).match(/\/ (\d+) 句/)[1]);
await page.selectOption('#filter-category', 'interview');
await page.selectOption('#filter-difficulty', 'hard');
await page.waitForTimeout(300);
const filtered = Number((await page.textContent('#filter-count')).match(/符合條件 (\d+)/)[1]);
check('篩選後句數變少', filtered > 0 && filtered < total, `${filtered} / ${total}`);
check('顯示的難度是困難', (await page.textContent('#difficulty')) === '困難');
await page.selectOption('#filter-category', '');
await page.selectOption('#filter-difficulty', '');
await page.waitForTimeout(200);

console.log('\n【3】錄音（假麥克風餵入真實語音檔）');
await page.click('#btn-record');
await page.waitForTimeout(600);
check('錄音時波形有顯示', await page.locator('#waveform').isVisible());
check('錄音時音量條有顯示', await page.locator('#level').isVisible());
check('錄音時篩選被停用', await page.locator('#filter-category').isDisabled());
check('音量指示有偵測到聲音', (await page.textContent('#level-text')) === '收音中');
await shot(page, '02-錄音中');
await page.waitForTimeout(2200);
await page.click('#btn-record');

await page.waitForSelector('#playback:not([hidden])', { timeout: 15000 });
check('停止錄音後音量條收起來', await page.locator('#level').isHidden());
check('停止錄音後篩選恢復可用', await page.locator('#filter-category').isEnabled());
const info = await page.textContent('#audio-info');
check('WAV 轉換完成', /WAV .* KB・.* 秒・16000 Hz/.test(info), info);
check('沒有被無人聲門檻誤擋', !(await page.textContent('#status')).includes('幾乎沒有聲音'));
check('model 選單有選項', (await page.locator('#model option').count()) >= 1);
check('送出鍵可按', await page.locator('#btn-submit').isEnabled());

console.log('\n【4】送出並取得講評');
await page.selectOption('#model', MODEL);
await page.click('#btn-submit');
await page.waitForSelector('#feedback-card:not([hidden])', { timeout: 90000 });
const feedback = await page.textContent('#feedback');
check('有顯示參考分數', /參考分數：\d+ \/ 100/.test(feedback), (feedback.match(/參考分數：\d+ \/ 100/) ?? [''])[0]);
check('有顯示 AI 聽到的內容', feedback.includes('AI 聽到的內容'));
check('有標註使用的 model', feedback.includes('由 ') && feedback.includes('評分'));
await shot(page, '03-講評');

console.log('\n【5】練習紀錄');
await page.waitForSelector('#history-card:not([hidden])', { timeout: 5000 });
check('紀錄卡片出現', await page.locator('#history-card').isVisible());
check('有一筆紀錄', (await page.locator('.history__item').count()) === 1);
check('統計有練習次數', (await page.textContent('#history-stats')).includes('練習次數'));

console.log('\n【6】重整後仍在（localStorage）');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#history-card:not([hidden])', { timeout: 10000 });
check('重整後紀錄還在', (await page.locator('.history__item').count()) === 1);
check('重整後記住選的 model', (await page.locator('#model').inputValue()) === MODEL);
await shot(page, '04-重整後');

console.log('\n【7】換一句要重置狀態');
await page.click('#btn-next');
await page.waitForTimeout(300);
check('換一句後錄音區塊收起來', await page.locator('#playback').isHidden());
check('換一句後波形收起來', await page.locator('#waveform').isHidden());
check('換一句後講評收起來', await page.locator('#feedback-card').isHidden());
check('換一句後紀錄仍在', await page.locator('#history-card').isVisible());

console.log('\n【8】JS 錯誤');
check('沒有 console error 或未捕捉例外', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${failed === 0 ? '全部通過' : `*** ${failed} 項失敗 ***`}`);
process.exit(failed === 0 ? 0 : 1);
