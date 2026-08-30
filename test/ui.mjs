// 前端 UI 測試（Playwright + headless Chromium）。**不需要金鑰、不呼叫 Gemini。**
//
// 跟 e2e.mjs 的分工：
//   e2e.mjs  真的錄音、真的呼叫 Gemini，驗的是整條路徑通不通（要金鑰、會吃配額）
//   ui.mjs   直接把假的練習紀錄塞進 localStorage，驗的是紀錄相關的畫面與互動
//
// 之所以要分開：趨勢圖、「重練這句」、加權抽句這些都是讀 localStorage 的紀錄，
// 用真的錄音去生資料的話，一次只生得出一筆，還要燒掉一次 API 呼叫。
// 抽句加權的數學本身在 test/practice.test.js 用純函式測，這裡只驗有沒有接對線。
//
//   npm start        # 另一個終端機（不用設 GEMINI_API_KEY 也能跑這支）
//   npm run test:ui
//
// 環境變數：BASE（預設 http://localhost:3000）、SHOTS（存截圖的目錄）、
//           CHROMIUM（Chromium 執行檔路徑，機器上已經有一份時可以指過去，
//           省掉 npx playwright install）

import { chromium } from '@playwright/test';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS;

const errors = [];
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : '*** FAIL ***'}  ${name}${extra ? '  → ' + extra : ''}`);
  if (!ok) failed++;
};
const shot = (page, name) =>
  SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : null;

const sentences = await fetch(`${BASE}/api/sentences`).then((r) => r.json());
if (!Array.isArray(sentences) || sentences.length < 3) {
  console.error(`讀不到練習句，${BASE} 上的伺服器有在跑嗎？`);
  process.exit(1);
}

/**
 * 造一批假的練習紀錄（由新到舊），塞進 localStorage 當成之前練過的成績。
 *
 * spec 是 `[句子索引, 分數, 幾小時前]`；第三個省略時就依序往前排一小時。
 * 「幾小時前」會影響間隔重複的權重與「該複習了」的提示，所以要能指定。
 */
function fakeHistory(specs) {
  return specs.map(([index, score, hoursAgo], i) => ({
    at: new Date(Date.now() - (hoursAgo ?? i + 1) * 3_600_000).toISOString(),
    sentenceId: sentences[index].id,
    sentenceText: sentences[index].text,
    category: sentences[index].category,
    difficulty: sentences[index].difficulty,
    score,
    transcript: sentences[index].text,
    problemWords: [],
    model: 'gemini-3.6-flash',
  }));
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
});
const context = await browser.newContext();
const page = await context.newPage();
// 這個專案沒有放 favicon，完整版 Chromium 會為此在 console 留一筆 404。
// 那不是 App 的錯誤，headless shell 也根本不會去要 favicon，所以濾掉。
// 訊息本文只有「Failed to load resource: 404」，看不出是誰，要從 location 判斷
page.on('console', (m) => {
  const where = m.location()?.url ?? '';
  if (m.type() === 'error' && !where.includes('favicon')) {
    errors.push(`${m.text()} ${where}`.trim());
  }
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

const seed = async (history) => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(
    (records) => window.localStorage.setItem('speaking-coach.history.v1', JSON.stringify(records)),
    history
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => !document.getElementById('sentence').textContent.includes('載入中')
  );
};

console.log(`\n受測網址 ${BASE}（不需要金鑰）`);

console.log('\n【1】只有一筆紀錄時不畫趨勢圖');
// 一個點連不成線，畫出來只會讓人以為壞了
await seed(fakeHistory([[0, 72]]));
check('紀錄卡片有出現', await page.locator('#history-card').isVisible());
check('趨勢圖是隱藏的', await page.locator('#history-trend').isHidden());

console.log('\n【2】多筆紀錄的趨勢圖');
const many = fakeHistory([
  [0, 91], [1, 88], [2, 55], [0, 74], [1, 62], [2, 43], [0, 80],
]);
await seed(many);
check('趨勢圖有出現', await page.locator('#history-trend').isVisible());
check('資料點數量等於紀錄數', (await page.locator('.trend__dot').count()) === many.length, `${await page.locator('.trend__dot').count()} 個`);
const caption = await page.textContent('#trend-caption');
check('說明文字有講清楚方向', /最近 7 次的分數走勢（左舊右新）/.test(caption), caption);
check('說明文字有算出進退步', /進步 \d+ 分|退步 \d+ 分|持平/.test(caption));
check('分數依高低上色', (await page.locator('.trend__dot--good').count()) > 0 && (await page.locator('.trend__dot--low').count()) > 0);
check('每個點都有 tooltip', (await page.locator('.trend__dot title').count()) === many.length);
await shot(page, 'ui-01-趨勢圖');

console.log('\n【3】超過上限只畫最近 20 筆');
await seed(fakeHistory(Array.from({ length: 26 }, (_, i) => [i % 3, 40 + (i % 50)])));
check('資料點停在 20 個', (await page.locator('.trend__dot').count()) === 20, `${await page.locator('.trend__dot').count()} 個`);
check('清單也只列 20 筆', (await page.locator('.history__item').count()) === 20);
check('有提示還有更早的紀錄', (await page.textContent('#history-list')).includes('較早的紀錄未顯示'));

console.log('\n【4】重練這句');
await seed(fakeHistory([[4, 38], [5, 90], [6, 51]]));
const targetText = sentences[4].text;
check('每一筆都有重練鍵', (await page.locator('.history__replay').count()) === 3);
await page.locator('.history__replay').first().click();
await page.waitForTimeout(200);
check('練習句換成被指定的那句', (await page.textContent('#sentence')) === targetText, targetText);
check('顯示這句練過幾次', /練過 1 次・38 分/.test(await page.textContent('#sentence-past')), await page.textContent('#sentence-past'));
check('沒有跳出篩選條件的提示', !(await page.textContent('#status')).includes('篩選條件'));
await shot(page, 'ui-02-重練這句');

console.log('\n【5】重練一句不在篩選條件內的句子');
// 條件不會被偷偷改掉，但要講清楚，不然按「換一句」會覺得句子莫名其妙跳走
const other = ['easy', 'medium', 'hard'].find((d) => d !== sentences[4].difficulty);
await page.selectOption('#filter-difficulty', other);
await page.waitForTimeout(200);
await page.locator('.history__replay').first().click();
await page.waitForTimeout(200);
check('句子照樣換過去', (await page.textContent('#sentence')) === targetText);
check('有提示這句不在條件內', (await page.textContent('#status')).includes('不在目前的篩選條件內'));
check('篩選條件沒有被偷偷改掉', (await page.locator('#filter-difficulty').inputValue()) === other);
await page.selectOption('#filter-difficulty', '');

console.log('\n【6】加權抽句的開關');
check('預設是開啟的', await page.locator('#pref-weighted').isChecked());
await page.uncheck('#pref-weighted');
check('關掉時有說明會怎樣', (await page.textContent('#status')).includes('等機率隨機'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(300);
check('重整後記得關著', !(await page.locator('#pref-weighted').isChecked()));
await page.check('#pref-weighted');
check('打開時也有說明', (await page.textContent('#status')).includes('優先抽出你分數比較低'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(300);
check('重整後記得開著', await page.locator('#pref-weighted').isChecked());

console.log('\n【7】加權不會讓任何句子抽不到（不設條件時每句都要抽得到）');
// 加權調過頭的症狀是「某幾句再也抽不到」。這裡只驗沒有句子被完全餓死 ——
// 機率分布本身在 test/practice.test.js 用純函式測。
await seed(fakeHistory([[0, 100], [0, 100], [0, 100], [1, 0], [1, 0], [2, 0]]));
const DRAWS = 200;
const seen = new Set();
for (let i = 0; i < DRAWS; i += 1) {
  await page.click('#btn-next');
  seen.add(await page.textContent('#sentence'));
}
// 加權後 100 分那句的機率約 1/83，200 次抽不到的機率約 9% —— 所以不單獨斷言它，
// 改看整體覆蓋率（漏掉 3 句以上的機率不到萬分之一）。單句的機率分布在
// test/practice.test.js 用純函式測，那裡才驗得準。
check(`${DRAWS} 次換句抽到過幾乎所有句子`, seen.size >= sentences.length - 2, `${seen.size} / ${sentences.length} 句`);
check('0 分的兩句一定抽得到', seen.has(sentences[1].text) && seen.has(sentences[2].text));

console.log('\n【8】間隔重複：久沒練的句子會被標成「該複習了」');
// 90 分的複習間隔約 3.5 天，所以 10 天前練的那句一定過期；1 小時前的那句一定沒有。
await seed(fakeHistory([[8, 90, 1], [9, 90, 240]]));
await page.locator('.history__replay').first().click();
await page.waitForTimeout(200);
const freshChip = await page.textContent('#sentence-past');
check('剛練過的句子顯示相對時間', /小時前|剛剛/.test(freshChip), freshChip);
check('剛練過的句子不會催你複習', !freshChip.includes('該複習了'), freshChip);

await page.locator('.history__replay').nth(1).click();
await page.waitForTimeout(200);
const staleChip = await page.textContent('#sentence-past');
check('久沒練的句子顯示天數', /天前/.test(staleChip), staleChip);
check('久沒練的句子被標成該複習了', staleChip.includes('該複習了'), staleChip);
check(
  '該複習的 chip 有自己的樣式（不然這行字混在灰字裡看不見）',
  await page.locator('#sentence-past.chip--due').isVisible()
);
await shot(page, 'ui-03-該複習了');

console.log('\n【9】清除紀錄');
page.once('dialog', (d) => d.accept());
await page.click('#btn-clear-history');
await page.waitForTimeout(200);
check('紀錄卡片收起來', await page.locator('#history-card').isHidden());
check('趨勢圖也收起來', await page.locator('#history-trend').isHidden());
check('句子旁的成績 chip 收起來', await page.locator('#sentence-past').isHidden());

console.log('\n【10】沒有紀錄時的初始畫面');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !document.getElementById('sentence').textContent.includes('載入中'));
check('紀錄卡片是隱藏的', await page.locator('#history-card').isHidden());
check('趨勢圖是隱藏的', await page.locator('#history-trend').isHidden());
check('成績 chip 是隱藏的', await page.locator('#sentence-past').isHidden());

console.log('\n【11】JS 錯誤');
check('沒有 console error 或未捕捉例外', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${failed === 0 ? '全部通過' : `*** ${failed} 項失敗 ***`}`);
process.exit(failed === 0 ? 0 : 1);
