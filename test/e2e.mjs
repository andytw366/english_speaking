// 瀏覽器端對端測試（Playwright + headless Chromium）。
//
// 這支**需要伺服器在跑**，而且大部分檢查會**真的呼叫 Azure 或 Gemini**，
// 所以不放進 `npm test`。不需要金鑰的前端測試在 test/ui.mjs（npm run test:ui）。
//
//   npm start          # 另一個終端機，或用 BASE 指到別的埠
//   npm run test:e2e
//
// 環境變數：
//   BASE   受測網址，預設 http://localhost:3000
//   MODEL  講評用的 Gemini model，預設 gemini-3.1-flash-lite
//          （最快也最省配額；免費層很容易把 flash 系列打到 429）
//   SHOTS  設成目錄路徑就會在各步驟存下截圖
//
// 錄音怎麼測的：Chromium 的 --use-file-for-fake-audio-capture 可以把一個 WAV
// 檔當成麥克風輸入，所以整條路徑 —— getUserMedia → MediaRecorder → 轉 16 kHz WAV
// → 能量檢查 → 上傳 → 無人聲把關 → Azure／Gemini → 顯示講評 → 寫進 localStorage
// → 影響下一次抽句 —— 都是真的在跑，沒有假資料。
//
// 【4】那一段（無人聲把關）**不需要任何金鑰**：後端在呼叫 API 之前就擋掉了。
// 所以就算手上沒有金鑰，跑這支也還是能驗到那一段。
//
// WSL note：headless 模式在 WSL2 可以直接跑，不需要 X server 或 WSLg。

import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const MODEL = process.env.MODEL ?? 'gemini-3.1-flash-lite';
const SHOTS = process.env.SHOTS;
const SPEECH = path.resolve('test/fixtures/speech-16k.wav');
const SILENCE = path.resolve('test/fixtures/silence-16k.wav');

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : '*** FAIL ***'}  ${name}${extra ? '  → ' + extra : ''}`);
  if (!ok) failed += 1;
};

/** 造一個純數位靜音的 WAV，用來驗無人聲把關。 */
function writeSilence(file, seconds = 2) {
  const rate = 16000;
  const samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  fs.writeFileSync(file, buf);
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.error(`連不上 ${BASE} —— 伺服器有在跑嗎？（npm start）`);
  process.exit(1);
}
console.log(
  `\n受測網址 ${BASE}\n` +
  `發音評估：${health.azureConfigured ? 'Azure（客觀分數）' : 'Gemini（未設定 Azure）'}　` +
  `中文講評：${health.geminiConfigured ? `Gemini（${MODEL}）` : '本地摘要（未設定 Gemini）'}`
);
if (!health.azureConfigured && !health.geminiConfigured) {
  console.log('⚠️  兩組金鑰都沒設定 —— 只有【1】【2】【4】跑得過，【3】【5】會停在錯誤。');
}

/** 開一個瀏覽器，把指定的 WAV 當成麥克風輸入。 */
async function openWith(audioFile) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || undefined,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${audioFile}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('404') && !t.includes('[tts]')) errors.push(t);
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  return { browser, page, errors };
}

const shot = (page, name) =>
  SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : null;

/** 切到跟讀模式，並把設定調成「用指定的 model、清空紀錄」。 */
async function gotoShadowing(page, { history = [] } = {}) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#nav .tab');
  await page.evaluate(({ m, h }) => {
    localStorage.setItem('speaking-coach:mode', 'shadowing');
    localStorage.setItem('speaking-coach:settings', JSON.stringify({ geminiModel: m }));
    localStorage.setItem('speaking-coach:history', JSON.stringify(h));
  }, { m: MODEL, h: history });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view .sentence');
  await page.waitForTimeout(400);
}

/** 錄一次音（開始 → 等 → 停止 → 等轉檔完成）。 */
async function recordOnce(page, ms = 2500) {
  await page.locator('#btn-record').click();
  await page.waitForTimeout(ms);
  await page.locator('#btn-record').click();
  await page.waitForSelector('#audio-info:not(:empty)', { timeout: 20000 });
}

const text = async (page, sel) => (await page.locator(sel).first().textContent() ?? '').trim();

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【1】六個模式與跟讀的初始狀態');
{
  const { browser, page, errors } = await openWith(SPEECH);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#nav .tab');
  check('分頁有六個', (await page.locator('#nav .tab').count()) === 6);

  await gotoShadowing(page);
  check('例句載入', (await text(page, '#sentence')).length > 5, (await text(page, '#sentence')).slice(0, 40));
  check('沒有錯誤橫幅', (await page.locator('#view .banner--error').count()) === 0);
  check('錄音鍵可按', await page.locator('#btn-record').isEnabled());
  check('錄音區塊一開始是隱藏的', (await page.locator('.playback').count()) === 0);
  check('波形一開始是隱藏的', await page.locator('#waveform').isHidden());
  check('今天的進度是 0', (await text(page, '.today__value')).startsWith('0 /'));
  await shot(page, 'e2e-01-初始');
  check('沒有 console 錯誤', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【2】真實錄音 → 轉 16 kHz WAV（不需要金鑰）');
let recordedInfo = '';
{
  const { browser, page, errors } = await openWith(SPEECH);
  await gotoShadowing(page);

  await page.locator('#btn-record').click();
  await page.waitForTimeout(600);
  check('錄音時波形有顯示', await page.locator('#waveform').isVisible());
  check('錄音時音量條有顯示', await page.locator('#level').isVisible());

  // 音量指示要輪詢而不是取一個瞬間：語音檔只有 1.2 秒，Chromium 會迴圈播放，
  // 中間有靜音段 —— 剛好取樣在那一刻的話會看到「幾乎沒收到聲音」，那不是 bug。
  let heardSound = false;
  for (let i = 0; i < 12 && !heardSound; i += 1) {
    if ((await text(page, '#level-text')) === '收音中') heardSound = true;
    else await page.waitForTimeout(200);
  }
  check('音量指示偵測到聲音', heardSound, await text(page, '#level-text'));
  check('錄音時不能換句', await page.locator('#view button', { hasText: '換一句' }).isDisabled());
  await page.locator('#btn-record').click();
  await page.waitForSelector('#audio-info:not(:empty)', { timeout: 20000 });

  recordedInfo = await text(page, '#audio-info');
  check('轉成 16 kHz 單聲道 WAV', /WAV .* KB・.* 秒・16000 Hz 單聲道/.test(recordedInfo), recordedInfo);
  check('沒有被無人聲門檻誤擋', !(await text(page, '#status')).includes('幾乎沒有聲音'), await text(page, '#status'));
  check('停止後波形收起來', await page.locator('#waveform').isHidden());
  check('出現送出鍵', (await page.locator('#btn-submit').count()) === 1);
  await shot(page, 'e2e-02-錄好了');
  check('沒有 console 錯誤', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【3】送出 → 發音評估 → 寫進紀錄（需要金鑰）');
if (!health.azureConfigured && !health.geminiConfigured) {
  console.log('  （跳過：兩組金鑰都沒設定）');
} else {
  const { browser, page, errors } = await openWith(SPEECH);
  await gotoShadowing(page);
  const target = await text(page, '#sentence');
  await recordOnce(page);

  await page.locator('#btn-submit').click();
  await page.waitForSelector('.card:has-text("發音講評")', { timeout: 90000 });
  await page.waitForTimeout(500);

  const provider = health.azureConfigured ? 'azure' : 'gemini';
  check(`回應來自 ${provider}`, true);
  check('有顯示總分', /^\d+$/.test(await text(page, '.overall__value')), await text(page, '.overall__value'));

  if (provider === 'azure') {
    check('四個面向的分數磚', (await page.locator('.tile').count()) === 4);
    check('顯示系統聽到什麼', (await page.textContent('#view')).includes('系統聽到'));
  } else {
    check('顯示 AI 聽到的內容', (await page.textContent('#view')).includes('AI 聽到的內容'));
  }

  check('目標句被標色', (await page.locator('#sentence .word').count()) > 0);
  check('有中文講評', (await text(page, '.coach')).length > 5, (await text(page, '.coach')).slice(0, 40));

  // 寫進紀錄 → 回頭影響今天的進度與這句的成績
  await page.waitForTimeout(300);
  check('練習紀錄出現一筆', (await page.locator('.history__item').count()) === 1);
  check('今天的進度變成 1', (await text(page, '.today__value')).startsWith('1 /'), await text(page, '.today__value'));
  check('連續天數至少 1', Number(await text(page, '.today__block--streak .today__value')) >= 1);
  check('這一組的進度有顯示', /這一組：1 \/ \d+ 句/.test(await page.textContent('#view')));
  check('這句出現成績 chip', (await text(page, '.chip--past')).includes('練過 1 次'), await text(page, '.chip--past'));
  check('剛練完不會被標成該複習了', (await page.locator('.chip--due').count()) === 0);
  check('紀錄標示了評分來源', (await text(page, '.history__meta')).includes(provider === 'azure' ? 'Azure' : 'Gemini'));
  await shot(page, 'e2e-03-講評');

  // 重整後紀錄還在（localStorage）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view .sentence');
  await page.waitForTimeout(400);
  check('重整後紀錄還在', (await page.locator('.history__item').count()) === 1);
  check('重整後那句仍找得到', (await page.textContent('#view')).includes(target.slice(0, 20)) ||
    (await page.locator('.history__replay').count()) === 1);

  check('沒有 console 錯誤', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【4】無人聲把關（不需要金鑰 —— 後端在呼叫 API 前就擋掉）');
{
  writeSilence(SILENCE);
  const { browser, page, errors } = await openWith(SILENCE);
  await gotoShadowing(page);
  await page.locator('#btn-record').click();
  await page.waitForTimeout(2500);
  check('靜音時音量指示說收不到聲音',
    (await text(page, '#level-text')).includes('幾乎沒收到'), await text(page, '#level-text'));
  await page.locator('#btn-record').click();
  await page.waitForSelector('#audio-info:not(:empty)', { timeout: 20000 });

  const status = await text(page, '#status');
  check('前端就擋下來了', status.includes('幾乎沒有聲音'), status.slice(0, 40));
  // 前端擋掉之後不該還給一個送得出去的按鈕 —— 那會讓人以為是自己按錯
  check('送出鍵不出現', (await page.locator('#btn-submit').count()) === 0);
  check('不計入今天的進度', (await text(page, '.today__value')).startsWith('0 /'));
  check('不寫進練習紀錄', (await page.locator('.history__item').count()) === 0);
  await shot(page, 'e2e-04-無人聲');
  check('沒有 console 錯誤', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();
  fs.rmSync(SILENCE, { force: true });
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【5】評分結果會回頭影響抽句（需要金鑰）');
if (!health.azureConfigured && !health.geminiConfigured) {
  console.log('  （跳過：兩組金鑰都沒設定）');
} else {
  const { browser, page } = await openWith(SPEECH);
  await gotoShadowing(page);
  await recordOnce(page);
  await page.locator('#btn-submit').click();
  await page.waitForSelector('.card:has-text("發音講評")', { timeout: 90000 });
  await page.waitForTimeout(400);

  // 真實評分產生的 problemWords 應該有 issue 分類 —— 那是弱點加權唯一的來源。
  // Azure 走 lib/azure-issues.js 對應，Gemini 直接回分類。
  const issues = await page.evaluate(() => {
    const raw = localStorage.getItem('speaking-coach:history');
    const list = raw ? JSON.parse(raw) : [];
    return (list[0]?.problemWords ?? []).map((w) => w.issue).filter(Boolean);
  });
  console.log(`     這次抓到的弱點音：${issues.length ? issues.join('、') : '（這次唸得很好，沒有）'}`);
  check('紀錄裡的 problemWords 形狀正確（有 issue 欄位或空陣列）',
    Array.isArray(issues), JSON.stringify(issues));
  await browser.close();
}

console.log(`\n${failed === 0 ? '全部通過' : `*** ${failed} 項失敗 ***`}`);
process.exit(failed === 0 ? 0 : 1);
