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

console.log('\n【7】加權不會讓任何句子抽不到');
// 加權調過頭的症狀是「某幾句再也抽不到」。這裡只驗沒有句子被完全餓死 ——
// 機率分布本身在 test/practice.test.js 用純函式測。
await seed(fakeHistory([[0, 100], [0, 100], [0, 100], [1, 0], [1, 0], [2, 0]]));

// 先在一個小池子裡驗「每一句都抽得到」。句庫有 80 句以上，
// 在全部句子裡跑 coupon collector 要 350 次以上才蓋得完，用真實點擊跑太慢；
// 縮小池子才驗得準，而餓死問題在小池子裡本來就更明顯。
await page.selectOption('#filter-difficulty', 'hard');
await page.selectOption('#filter-category', 'travel');
await page.waitForTimeout(200);
const poolSize = Number((await page.textContent('#filter-count')).match(/符合條件 (\d+)/)[1]);
const poolSeen = new Set();
for (let i = 0; i < poolSize * 15; i += 1) {
  await page.click('#btn-next');
  poolSeen.add(await page.textContent('#sentence'));
}
check(`小池子（${poolSize} 句）每一句都抽得到`, poolSeen.size === poolSize, `${poolSeen.size} / ${poolSize} 句`);

// 再回到完整句庫看整體覆蓋率，確認沒有一整區被權重壓到抽不出來
await page.selectOption('#filter-difficulty', '');
await page.selectOption('#filter-category', '');
await page.waitForTimeout(200);
const DRAWS = 200;
const seen = new Set();
for (let i = 0; i < DRAWS; i += 1) {
  await page.click('#btn-next');
  seen.add(await page.textContent('#sentence'));
}
// 等機率下 200 抽平均蓋到約九成，這裡抓八成當下限（低於它幾乎不可能是巧合）
check(
  `${DRAWS} 次換句蓋到八成以上的句子`,
  seen.size >= Math.floor(sentences.length * 0.8),
  `${seen.size} / ${sentences.length} 句`
);
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

console.log('\n【9】逐字的發音問題（音素級回饋）');
// 這一段不用真的錄音也測得到：直接在頁面裡 import feedback-view.js 來畫。
// 走真實流程要金鑰、要錄音，而這裡要驗的是「拿到這樣的資料時畫成什麼」。
await page.goto(BASE);
await page.waitForSelector('#sentence:not(:empty)');
const sentenceText = await page.textContent('#sentence');
await page.evaluate(async (text) => {
  const { renderFeedback } = await import('/feedback-view.js');
  renderFeedback(
    {
      card: document.getElementById('feedback-card'),
      body: document.getElementById('feedback'),
      sentence: document.getElementById('sentence'),
    },
    {
      speech_detected: true,
      transcript: text,
      score: 72,
      problem_words: [
        { word: text.split(/\s+/)[0], heard: 'sorrowly', issue: 'th', tip_zh: '舌尖輕輕伸到上下門牙之間送氣，不要用 s' },
        { word: text.split(/\s+/)[1], heard: text.split(/\s+/)[1], issue: 'stress', tip_zh: '重音放在第一個音節' },
      ],
      feedback_zh: '• 整體不錯',
      model: 'gemini-3.6-flash',
    },
    { sentenceText: text, labelForModel: (id) => id }
  );
}, sentenceText);

check('列出兩個要練的字', (await page.locator('.problems__item').count()) === 2);
check('每個字都有分類標籤', (await page.locator('.problems__item .chip--issue').count()) === 2);
check('th 顯示成中文標籤而不是代碼', (await page.textContent('.problems__list')).includes('th 音'));
check('有「你唸成什麼」', (await page.textContent('.problems__list')).includes('你唸成：sorrowly'));
check(
  '唸得跟目標一樣時不寫「你唸成」（不然那行字只會讓人困惑）',
  (await page.locator('.problems__heard').count()) === 1
);
check('有嘴巴該怎麼做的提示', (await page.textContent('.problems__list')).includes('舌尖輕輕伸到'));
check('每個字都有單獨的播放鍵', (await page.locator('.problems__play').count()) === 2);
check('被點名的字在句子裡標紅了', (await page.locator('#sentence .word--miss').count()) >= 2);
await shot(page, 'ui-04-音素級回饋');

// 沒有問題字時不要留一個空的區塊
await page.evaluate(async (text) => {
  const { renderFeedback } = await import('/feedback-view.js');
  renderFeedback(
    {
      card: document.getElementById('feedback-card'),
      body: document.getElementById('feedback'),
      sentence: document.getElementById('sentence'),
    },
    { speech_detected: true, transcript: text, score: 98, problem_words: [], feedback_zh: '• 很好' },
    { sentenceText: text, labelForModel: (id) => id }
  );
}, sentenceText);
check('都唸對時不會留下空的區塊', (await page.locator('.problems').count()) === 0);

console.log('\n【10】依弱點音抽句');
// 紀錄裡塞一批「th 一直錯」的練習，句子旁邊要說明這句在練 th
const thHeavy = fakeHistory([[0, 50], [1, 50], [2, 50], [3, 50]]).map((r) => ({
  ...r,
  problemWords: [{ word: 'think', issue: 'th', heard: 'sink', tip_zh: '舌尖伸到門牙之間' }],
}));
await seed(thHeavy);

// 換幾次句子，總會抽到練得到 th 的句子（th 的句子權重是別人的兩倍）
let focusChip = '';
for (let i = 0; i < 40 && !focusChip; i += 1) {
  if (await page.locator('#sentence-focus').isVisible()) {
    focusChip = await page.textContent('#sentence-focus');
    break;
  }
  await page.click('#btn-next');
}
check('抽到練得到弱點音的句子時會說明', focusChip.includes('這句在練'), focusChip || '(40 次都沒出現)');
check('說明裡是中文標籤而不是代碼', focusChip.includes('th 音'), focusChip);
await shot(page, 'ui-05-弱點音');

// 關掉加權時弱點音也不再影響抽句，那個 chip 就不該繼續掛著
await page.uncheck('#pref-weighted');
await page.waitForTimeout(150);
check('關掉加權後就不再顯示', await page.locator('#sentence-focus').isHidden());
await page.check('#pref-weighted');

console.log('\n【11】今天的進度與連續天數');
// 紀錄一律放在本地時間的中午，避開午夜與日光節約的邊界 ——
// 不然這支測試會在半夜跑的時候紅一次，隔天自己又好了。
const noonDaysAgo = (daysAgo) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(12, 0, 0, 0);
  return date.toISOString();
};
const onDays = (offsets) =>
  offsets.map((daysAgo, i) => ({
    at: noonDaysAgo(daysAgo),
    sentenceId: sentences[i % sentences.length].id,
    sentenceText: sentences[i % sentences.length].text,
    category: sentences[i % sentences.length].category,
    difficulty: sentences[i % sentences.length].difficulty,
    score: 70,
    transcript: '',
    problemWords: [],
    model: 'gemini-3.6-flash',
  }));

await seed(onDays([0, 0, 1, 2]));
check('今天的句數是今天那幾筆', (await page.textContent('#today-count')).startsWith('2 /'), await page.textContent('#today-count'));
check('連續天數算到今天', (await page.textContent('#streak-count')) === '3');
check('沒達標時說還差幾句', (await page.textContent('#today-note')).includes('再 3 句'), await page.textContent('#today-note'));

// 今天還沒練不該讓連續天數馬上歸零 —— 那是最不該讓人放棄的時間點
await seed(onDays([1, 2]));
check('今天還沒練時連續天數不歸零', (await page.textContent('#streak-count')) === '2');
check('今天是 0 句', (await page.textContent('#today-count')).startsWith('0 /'));

await seed(onDays([0, 0, 0, 0, 0]));
check('達成目標時有講', (await page.textContent('#today-note')).includes('達成'), await page.textContent('#today-note'));
check('達標的數字會變色', await page.locator('#today-count.today__value--done').isVisible());
await shot(page, 'ui-06-今天的進度');

// 每日目標記在 localStorage
await page.selectOption('#daily-goal', '10');
await page.waitForTimeout(100);
check('改目標後分母跟著變', (await page.textContent('#today-count')).endsWith('/ 10'));
await page.reload();
await page.waitForSelector('#sentence:not(:empty)');
check('重整後記得選的目標', (await page.locator('#daily-goal').inputValue()) === '10');

console.log('\n【12】一組練完的總結');
await page.evaluate(async () => {
  const { renderSetSummary } = await import('/set-view.js');
  const { summariseSet } = await import('/practice.js');
  const records = [
    { score: 60, problemWords: [{ word: 'thoroughly', issue: 'th' }, { word: 'really', issue: 'r_l' }] },
    { score: 70, problemWords: [{ word: 'think', issue: 'th' }] },
    { score: 90, problemWords: [] },
    { score: 55, problemWords: [{ word: 'three', issue: 'th' }] },
    { score: 80, problemWords: [] },
  ];
  renderSetSummary(
    { stats: document.getElementById('set-stats'), issues: document.getElementById('set-issues') },
    summariseSet(records)
  );
  document.getElementById('set-card').hidden = false;
});
check('總結有三塊統計', (await page.locator('#set-stats .stat').count()) === 3);
check('平均分算對了', (await page.textContent('#set-stats')).includes('71'), await page.textContent('#set-stats'));
check('最高最低都在', (await page.textContent('#set-stats')).includes('90 / 55'));
check('最常出現的問題排在第一', (await page.textContent('#set-issues .set__list li')).includes('th 音'));
check('列出被點名的字', (await page.textContent('#set-issues')).includes('thoroughly'));
check('有「再練一組」', await page.locator('#btn-next-set').isVisible());
await shot(page, 'ui-07-一組練完');

await page.evaluate(async () => {
  const { renderSetSummary } = await import('/set-view.js');
  const { summariseSet } = await import('/practice.js');
  renderSetSummary(
    { stats: document.getElementById('set-stats'), issues: document.getElementById('set-issues') },
    summariseSet([{ score: 95, problemWords: [] }])
  );
});
check('都唸對時講的是好消息，不是一片空白', (await page.textContent('#set-issues')).includes('沒有被點名'));

console.log('\n【13】清除紀錄');
page.once('dialog', (d) => d.accept());
await page.click('#btn-clear-history');
await page.waitForTimeout(200);
check('紀錄卡片收起來', await page.locator('#history-card').isHidden());
check('趨勢圖也收起來', await page.locator('#history-trend').isHidden());
check('句子旁的成績 chip 收起來', await page.locator('#sentence-past').isHidden());

console.log('\n【14】沒有紀錄時的初始畫面');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !document.getElementById('sentence').textContent.includes('載入中'));
check('紀錄卡片是隱藏的', await page.locator('#history-card').isHidden());
check('趨勢圖是隱藏的', await page.locator('#history-trend').isHidden());
check('成績 chip 是隱藏的', await page.locator('#sentence-past').isHidden());

console.log('\n【15】JS 錯誤');
check('沒有 console error 或未捕捉例外', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${failed === 0 ? '全部通過' : `*** ${failed} 項失敗 ***`}`);
process.exit(failed === 0 ? 0 : 1);
