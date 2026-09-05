// 前端 UI 測試（Playwright + headless Chromium）。**不需要金鑰、不呼叫 Azure 或 Gemini。**
//
// 跟 e2e.mjs 的分工：
//   e2e.mjs  真的錄音、真的呼叫 API，驗的是整條路徑通不通（要金鑰、會吃配額）
//   ui.mjs   把假的練習紀錄塞進 localStorage、或直接 import 畫面模組餵資料進去
//
// 之所以要分開：練習紀錄、趨勢圖、一組總結、加權抽句這些都要「有一批紀錄」
// 才測得到，用真的錄音去生資料的話一次只生得出一筆，還要燒掉一次 API 呼叫。
// 規則本身（間隔重複、弱點音分類）在 test/*.test.js 用純函式測，這裡只驗接線。
//
//   npm start        # 另一個終端機（不用設任何金鑰）
//   npm run test:ui
//
// 環境變數：BASE（預設 http://localhost:3000）、SHOTS（存截圖的目錄）、
//           CHROMIUM（Chromium 執行檔路徑，機器上已經有一份時可以指過去）

import fs from 'node:fs';
import os from 'node:os';

import { chromium } from '@playwright/test';

// 出題規則的那份純函式。測試要知道「哪個選項才是對的」才能故意答錯，
// 所以直接用 App 用的同一份，而不是在這裡再抄一次切義項的邏輯。
import { firstSense } from '../public/lib/quiz.js';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS;

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : '*** FAIL ***'}  ${name}${extra ? '  → ' + extra : ''}`);
  if (!ok) failed += 1;
};
const shot = (page, name) =>
  SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : null;

const sentences = await fetch(`${BASE}/api/content/sentences`).then((r) => r.json());
if (!Array.isArray(sentences) || sentences.length < 10) {
  console.error(`讀不到練習句，${BASE} 上的伺服器有在跑嗎？`);
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
// acceptDownloads：備份那一段會真的下載一個檔案再讀回來
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

// 這個專案沒有放 favicon，完整版 Chromium 會為此在 console 留一筆 404。
// headless shell 根本不會去要 favicon，所以濾掉。
// TTS 的錯誤也濾掉：headless 沒有安裝任何語音包，那不是 App 的問題。
const errors = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() !== 'error') return;
  if (t.includes('404') || t.includes('[tts]')) return;
  errors.push(t);
});
page.on('pageerror', (e) => errors.push(String(e)));

const text = async (sel) => (await page.locator(sel).first().textContent() ?? '').trim();
const viewText = async () => (await page.textContent('#view')).replace(/\s+/g, ' ');

/** 本地時間 n 天前的中午。用中午避開午夜與日光節約的邊界。 */
const noonDaysAgo = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
};

/**
 * 造假的練習紀錄。spec 是 `[句子索引, 分數, 幾天前, issue 代碼]`。
 * `problemWords` 的形狀跟 Azure 與 Gemini 兩條路徑產出的一致（見 lib/azure-issues.js）。
 */
const fakeHistory = (specs) =>
  specs.map(([index, score, daysAgo = 0, issue = null]) => {
    const s = sentences[index % sentences.length];
    return {
      at: noonDaysAgo(daysAgo),
      sentenceId: s.id,
      sentenceText: s.text,
      category: s.category,
      difficulty: s.difficulty,
      score,
      provider: 'azure',
      transcript: s.text,
      problemWords: issue ? [{ word: s.text.split(' ')[0], issue, heard: '', tip_zh: '' }] : [],
    };
  });

/**
 * 塞紀錄與設定，重新載入，切到指定模式。
 *
 * `srs`（複習進度）與 `activity`（每天各模式練了幾個）預設清空 —— 不清的話
 * 上一段測試留下的資料會讓「還沒開始」「今天 0 / 20」這種斷言時好時壞。
 * 實際踩過：加了選擇題那一段之後，它接在「每日目標」後面跑，
 * 今天的份已經被上一段用掉 3 張，counter 變成 1 / 17 而不是 1 / 20。
 *
 * **沒給 `activity` 時是把那個鍵刪掉、不是寫成 `{}`** —— App 找不到它才會從
 * 舊的 `vocabDays` 與跟讀紀錄生一份出來，而跟讀那幾段正是靠這條路徑拿到今天的數字。
 */
async function seed({
  history = [], settings = {}, mode = 'shadowing', srs = {}, activity = null,
} = {}) {
  await page.evaluate(({ h, s, m, r, a }) => {
    localStorage.setItem('speaking-coach:history', JSON.stringify(h));
    localStorage.setItem('speaking-coach:settings', JSON.stringify(s));
    localStorage.setItem('speaking-coach:mode', m);
    localStorage.setItem('speaking-coach:srs', JSON.stringify(r));
    localStorage.removeItem('speaking-coach:srsVersion');
    localStorage.removeItem('speaking-coach:vocabDays');
    if (a) localStorage.setItem('speaking-coach:activity', JSON.stringify(a));
    else localStorage.removeItem('speaking-coach:activity');
  }, { h: history, s: settings, m: mode, r: srs, a: activity });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#nav .tab');
  await page.waitForTimeout(500);
}

await page.goto(BASE);
await page.waitForSelector('#nav .tab');

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【1】七個分頁都載入得起來');

const tabs = await page.locator('#nav .tab').allTextContents();
check('分頁有七個（首頁 + 五個練習 + 設定）', tabs.length === 7, tabs.join(' | '));

for (const tab of tabs) {
  const name = tab.split(' ').pop();
  await page.locator('#nav .tab', { hasText: name }).first().click();
  await page.waitForTimeout(600);
  const body = await viewText();
  const broken = await page.locator('#view .banner--error').count();
  check(`${name} 沒有錯誤橫幅`, broken === 0, broken ? await text('#view .banner--error') : '');
  // h() 會過濾 false 子元素，但裸的 el.append() 不會 —— 這一類 bug 在中翻英出現過
  check(`${name} 沒有殘留的 false / undefined`, !/\bfalse\b|\bundefined\b|\[object /.test(body));
}
await shot(page, 'ui-01-六個模式');

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【2】跟讀：今天的進度與連續天數');

// 今天兩句、昨天一句、前天一句 → 連續 3 天
await seed({ history: fakeHistory([[0, 42, 0], [1, 88, 0], [2, 61, 1], [3, 75, 2]]) });
check('今天的進度卡片有出現', await page.locator('.card--today').isVisible());
check('今天算 2 句', (await text('.today__value')).startsWith('2 /'), await text('.today__value'));
check('連續天數是 3', (await text('.today__block--streak .today__value')) === '3');
check('沒達標時說還差幾句', (await viewText()).includes('再 3 句'), await text('.card--today .hint'));
check('每日目標有四個選項', (await page.locator('.today__goal select option').count()) === 4);

// 今天還沒練不該讓連續天數馬上歸零 —— 那是最不該讓人放棄的時間點
await seed({ history: fakeHistory([[0, 70, 1], [1, 70, 2]]) });
check('今天還沒練時連續天數不歸零', (await text('.today__block--streak .today__value')) === '2');
check('今天是 0 句', (await text('.today__value')).startsWith('0 /'));

await seed({ history: fakeHistory([[0, 70, 0], [1, 70, 0], [2, 70, 0], [3, 70, 0], [4, 70, 0]]) });
check('達成目標時有講', (await viewText()).includes('達成'));
check('達標的數字會變色', await page.locator('.today__value--done').isVisible());
await shot(page, 'ui-02-今天的進度');

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【3】跟讀：練習紀錄與趨勢圖');

await seed({ history: fakeHistory([[0, 42, 0], [1, 88, 1], [2, 61, 2], [3, 95, 3], [4, 55, 4]]) });
check('紀錄列出五筆', (await page.locator('.history__item').count()) === 5);
check('統計有三塊', (await page.locator('.stats .stat').count()) >= 3);
check('趨勢圖有五個點', (await page.locator('.trend__dot').count()) === 5);
check('趨勢圖有文字說明', (await text('.trend figcaption')).includes('分數走勢'));
check('每個點都有 tooltip', (await page.locator('.trend__dot title').count()) === 5);
check('每一筆都有重練鍵', (await page.locator('.history__replay').count()) === 5);
check('紀錄有標示評分來源', (await text('.history__meta')).includes('Azure'), await text('.history__meta'));
await shot(page, 'ui-03-練習紀錄');

// 只有一筆時畫不出「走勢」，一條線兩個端點才有意義
await seed({ history: fakeHistory([[0, 70, 0]]) });
check('只有一筆時不畫趨勢圖', (await page.locator('.trend').count()) === 0);

await seed({ history: [] });
check('沒有紀錄時整張卡片不出現', (await page.locator('.history__item').count()) === 0);
check('沒有紀錄時也沒有成績 chip', (await page.locator('.chip--past').count()) === 0);

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【4】跟讀：重練這句與成績 chip');

await seed({ history: fakeHistory([[7, 38, 0], [8, 90, 10]]) });
const target = sentences[7].text;
await page.locator('.history__replay').first().click();
await page.waitForTimeout(400);
check('句子換成被指定的那句', (await text('#sentence')) === target, (await text('#sentence')).slice(0, 40));
check('顯示這句練過幾次與分數', /練過 1 次・38 分/.test(await text('.chip--past')), await text('.chip--past'));
check('剛練過不會催你複習', !(await text('.chip--past')).includes('該複習了'), await text('.chip--past'));

// 90 分的複習間隔約 3.5 天，10 天前練的那句一定過期
await page.locator('.history__replay').nth(1).click();
await page.waitForTimeout(400);
check('久沒練的顯示天數', /天前/.test(await text('.chip--past')), await text('.chip--past'));
check('久沒練的被標成該複習了', (await text('.chip--past')).includes('該複習了'));
check('該複習的 chip 有自己的樣式', await page.locator('.chip--past.chip--due').isVisible());
await shot(page, 'ui-04-該複習了');

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【5】跟讀：弱點音會回頭影響抽句');

// 紀錄裡 th 連續出問題（形狀跟 Azure 路徑產出的一致）
await seed({ history: fakeHistory([[0, 50, 0, 'th'], [1, 50, 1, 'th'], [2, 50, 2, 'th'], [3, 50, 3, 'th']]) });
let focusChip = '';
for (let i = 0; i < 40; i += 1) {
  if (await page.locator('.chip--focus').count()) { focusChip = await text('.chip--focus'); break; }
  await page.locator('#view button', { hasText: '換一句' }).click();
  await page.waitForTimeout(60);
}
check('抽到練得到弱點音的句子時會說明', focusChip.includes('這句在練'), focusChip || '40 次都沒出現');
check('說明用中文標籤而不是代碼', focusChip.includes('th 音'), focusChip);
await shot(page, 'ui-05-弱點音');

await page.locator('#view .check input').uncheck();
await page.waitForTimeout(300);
check('關掉加權後就不再顯示弱點音', (await page.locator('.chip--focus').count()) === 0);
await page.locator('#view .check input').check();
await page.waitForTimeout(200);
check('加權開關記在設定裡', await page.locator('#view .check input').isChecked());

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【6】跟讀：中文意思');

await seed({ history: [] });
let withZh = 0;
let blankZh = 0;
for (let i = 0; i < 25; i += 1) {
  const shown = await page.locator('.sentence__zh').count();
  const zh = shown ? (await text('.sentence__zh')) : '';
  if (shown && zh) withZh += 1;
  if (shown && !zh) blankZh += 1;
  await page.locator('#view button', { hasText: '換一句' }).click();
  await page.waitForTimeout(60);
}
check('有中文的句子會顯示中文', withZh > 0, `25 句裡有 ${withZh} 句`);
check('沒有中文的句子不會留一行空白', blankZh === 0);

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【7】加權不會讓任何句子抽不到');

// 在一個小池子裡驗。句庫有兩千句以上，在全部句子裡跑 coupon collector
// 要上萬次點擊才蓋得完；縮小池子才驗得準，而餓死問題在小池子裡本來就更明顯。
const smallPool = sentences.filter((s) => s.category === 'interview' && s.difficulty === 'easy');
const idxOf = (id) => sentences.findIndex((s) => s.id === id);
// 兩句都是十天前練的：這樣「剛練完會被壓低」的時間因素在兩邊都打平，
// 剩下的差距純粹來自分數。都設成今天的話兩句都被壓到最低權重，
// 抽到的次數只有個位數，這條斷言就會偶爾隨機紅一次。
await seed({
  history: fakeHistory([
    [idxOf(smallPool[0].id), 100, 10], [idxOf(smallPool[0].id), 100, 11],
    [idxOf(smallPool[1].id), 0, 10], [idxOf(smallPool[1].id), 0, 11],
  ]),
  settings: { categories: ['interview'], difficulties: ['easy'] },
});

const seen = new Map();
for (let i = 0; i < 150; i += 1) {
  const t = await text('#sentence');
  seen.set(t, (seen.get(t) ?? 0) + 1);
  await page.locator('#view button', { hasText: '換一句' }).click();
  await page.waitForTimeout(25);
}
// 容忍漏一句：被壓到最低權重的那句期望值只有兩三次，偶爾抽不到是機率而不是 bug。
// 「權重永遠不為零」這條數學性質在 test/practice.test.js 測得更準。
check(`小池子（${smallPool.length} 句）幾乎每一句都抽得到`,
  seen.size >= smallPool.length - 1, `${seen.size} / ${smallPool.length} 句`);
const low = seen.get(smallPool[1].text) ?? 0;
const high = seen.get(smallPool[0].text) ?? 0;
check('練得爛的那句明顯比練得好的那句常出現', low > high * 2, `0 分那句 ${low} 次、100 分那句 ${high} 次`);
check('篩選條件真的有生效', (await text('.card__meta')).includes('面試'), await text('.card__meta'));

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【8】發音講評的兩條路徑');

await seed({ history: [], settings: {} });

// Azure：逐字、逐音素的客觀分數
await page.evaluate(async () => {
  const { renderAssessment } = await import('/modes/assessment-view.js');
  const card = document.createElement('div');
  card.id = 'probe';
  document.getElementById('view').append(card);
  renderAssessment(card, {
    provider: 'azure',
    referenceText: 'I think so.',
    recognizedText: 'I sink so.',
    scores: { pronunciation: 72, accuracy: 68, fluency: 85, completeness: 100, prosody: 55 },
    words: [
      { word: 'I', accuracy: 95, errorType: 'None', phonemes: [{ phoneme: 'aɪ', accuracy: 95 }] },
      { word: 'think', accuracy: 40, errorType: 'Mispronunciation',
        phonemes: [{ phoneme: 'θ', accuracy: 20 }, { phoneme: 'ɪ', accuracy: 90 }] },
      { word: 'so', accuracy: 90, errorType: 'None', phonemes: [{ phoneme: 's', accuracy: 92 }] },
    ],
    feedback_zh: '• th 要把舌尖輕觸上齒',
  }, 'I think so.', () => {});
});
check('Azure：顯示發音總分', (await text('#probe .overall__value')) === '72');
check('Azure：四個面向的分數磚', (await page.locator('#probe .tile').count()) === 4);
check('Azure：列出需要加強的字', (await text('#probe .worddetail')).includes('think'));
check('Azure：顯示弱的音素', (await text('#probe .phonemes')).includes('θ'));
check('Azure：顯示系統聽到什麼', (await text('#probe')).includes('I sink so.'));
await shot(page, 'ui-06-Azure 講評');

// Gemini 退路：主觀分數 + 逐字的口腔動作提示
await page.evaluate(async () => {
  const { renderAssessment } = await import('/modes/assessment-view.js');
  const card = document.createElement('div');
  card.id = 'probe2';
  document.getElementById('view').append(card);
  renderAssessment(card, {
    provider: 'gemini',
    score: 66,
    transcript: 'I sink so',
    problem_words: [
      { word: 'think', heard: 'sink', issue: 'th', tip_zh: '舌尖輕輕伸到上下門牙之間送氣' },
      { word: 'so', heard: 'so', issue: 'other', tip_zh: '' },
    ],
    feedback_zh: '• 整體不錯',
  }, 'I think so.', () => {});
});
check('Gemini：顯示參考分數', (await text('#probe2 .overall__value')) === '66');
check('Gemini：列出可以再練的字', (await page.locator('#probe2 .problems__item').count()) === 2);
check('Gemini：顯示「你唸成什麼」', (await text('#probe2')).includes('你唸成：sink'));
check('Gemini：唸對的字不寫「你唸成」', (await page.locator('#probe2 .problems__heard').count()) === 1);
check('Gemini：issue 顯示中文標籤', (await text('#probe2 .chip--issue')).includes('th 音'));
check('Gemini：每個字都有單獨播放鍵', (await page.locator('#probe2 .problems__play').count()) === 2);
await shot(page, 'ui-07-Gemini 講評');

// 講評缺席的原因要各講各的話 —— 「你自己關掉的」跟「這次沒回來」不能寫成同一句
const narrationNote = (data) => page.evaluate(async (d) => {
  const { renderAssessment } = await import('/modes/assessment-view.js');
  const card = document.createElement('div');
  document.getElementById('view').append(card);
  renderAssessment(card, {
    provider: 'azure',
    referenceText: 'I think so.',
    recognizedText: 'I think so.',
    scores: { pronunciation: 88, accuracy: 90, fluency: 85, completeness: 100, prosody: 80 },
    words: [],
    feedback_zh: '• 摘要',
    ...d,
  }, 'I think so.', () => {});
  const notes = [...card.querySelectorAll('.hint')].map((el) => el.textContent);
  return notes.join(' | ');
}, data);

const offNote = await narrationNote({ narrationSource: 'local', narrationReason: 'disabled' });
check('關掉講評時說得出是自己關的', offNote.includes('已關閉') && offNote.includes('設定'), offNote);

const failNote = await narrationNote({ narrationSource: 'local', narrationReason: 'failed' });
check('講評失敗時不會說成「已關閉」',
  failNote.includes('沒有回來') && !failNote.includes('已關閉'), failNote);

const okNote = await narrationNote({ narrationSource: 'gemini', narrationMs: 6400 });
check('用了 Gemini 時把等待秒數寫出來', okNote.includes('6.4 秒'), okNote);

const oldNote = await narrationNote({ narrationSource: 'local' });
check('舊回應（只有 narrationSource）也還有說明', oldNote.includes('本地摘要'), oldNote);

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【9】一組練完的總結');

await page.evaluate(async () => {
  const { renderSetSummary } = await import('/modes/shadowing-views.js');
  const { summariseSet } = await import('/lib/practice.js');
  const records = [
    { score: 60, problemWords: [{ word: 'thoroughly', issue: 'th' }, { word: 'really', issue: 'r_l' }] },
    { score: 70, problemWords: [{ word: 'think', issue: 'th' }] },
    { score: 90, problemWords: [] },
    { score: 55, problemWords: [{ word: 'three', issue: 'th' }] },
    { score: 80, problemWords: [] },
  ];
  const el = renderSetSummary(summariseSet(records), () => {});
  el.id = 'probe3';
  document.getElementById('view').append(el);
});
check('總結有三塊統計', (await page.locator('#probe3 .stat').count()) === 3);
check('平均分算對了', (await text('#probe3 .stats')).includes('71'));
check('最高最低都在', (await text('#probe3 .stats')).includes('90 / 55'));
check('最常出現的問題排第一', (await text('#probe3 .set__list li')).includes('th 音'));
check('列出被點名的字', (await text('#probe3')).includes('thoroughly'));
check('說明會接回抽句', (await text('#probe3')).includes('接下來會多抽'));
check('有「再練一組」', (await page.locator('#probe3 button').count()) === 1);
await shot(page, 'ui-08-一組練完');

await page.evaluate(async () => {
  const { renderSetSummary } = await import('/modes/shadowing-views.js');
  const { summariseSet } = await import('/lib/practice.js');
  const el = renderSetSummary(summariseSet([{ score: 95, problemWords: [] }]), () => {});
  el.id = 'probe4';
  document.getElementById('view').append(el);
});
check('都唸對時講的是好消息，不是一片空白',
  (await text('#probe4')).includes('沒有被點名'));

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【10】設定頁');

await seed({ history: [], settings: {}, mode: 'settings' });
// 用 .field + hasText 抓，不吃 .chips 的順序 —— 順序型的選擇器被新卡片插隊過一次了
const catChips = await page.locator('.field', { hasText: '只練這些情境' })
  .locator('button').allTextContents();
check('八種情境都選得到', catChips.length === 8, catChips.join('、'));
check('三種難度都選得到', (await page.locator('.field', { hasText: '只練這些難度' })
  .locator('button').count()) === 3);
check('有 Gemini model 選單', (await page.locator('#gemini-model option').count()) >= 3,
  `${await page.locator('#gemini-model option').count()} 個`);

// 中文講評的開關：預設是開的，關掉要寫進 localStorage（跟讀送出時就靠它決定送不送 narrate）
const narrationChips = page.locator('.field', { hasText: '跟讀的中文講評' }).locator('button');
check('有中文講評的開關', (await narrationChips.count()) === 2);
check('預設是「要」', (await narrationChips.first().getAttribute('class')).includes('togglechip--on'));

await narrationChips.nth(1).click();
await page.waitForTimeout(200);
const savedOff = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('speaking-coach:settings') ?? '{}').geminiNarration);
check('關掉會存進設定', savedOff === false, String(savedOff));
check('關掉之後畫面說的是本地摘要',
  (await page.locator('.field', { hasText: '跟讀的中文講評' }).textContent()).includes('本地摘要'));

await narrationChips.first().click();
await page.waitForTimeout(200);
check('開回來也存得回去', (await page.evaluate(() =>
  JSON.parse(localStorage.getItem('speaking-coach:settings') ?? '{}').geminiNarration)) === true);
await shot(page, 'ui-09-設定');

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【11】單字卡：選難度、各級進度、舊進度搬家');

// 舊格式的複習進度（鍵是 band-1:N）。band-1 的前 40 個字有一半熟練、一半學習中。
const legacySrs = {};
for (let i = 1; i <= 40; i++) {
  legacySrs[`band-1:${i}`] = i % 2
    ? { box: 5, due: Date.now() - 1000, seen: 6, correct: 6 }
    : { box: 2, due: Date.now() + 9e6, seen: 2, correct: 1 };
}
legacySrs['curated:1'] = { box: 3, due: Date.now(), seen: 3, correct: 2 };

await seed({ mode: 'vocabulary', settings: { vocabDeck: 'tier-1', dailyGoals: { vocabulary: 3 } }, srs: legacySrs });
await page.waitForSelector('.deckbar');

check('顯示我在第幾級', (await text('.deckbar')).includes('第 1 級 / 共 6 級'),
  (await text('.deckbar')).replace(/\s+/g, ' '));
check('顯示今天的進度', (await text('.card--today')).includes('0 / 3'),
  (await text('.card--today')).replace(/\s+/g, ' '));
check('一次只抽今天的份', (await text('.counter')).trim() === '1 / 3',
  (await text('.counter')).trim());
check('說明指向設定', (await viewText()).includes('在「設定」可以改'));

// 舊鍵 band-1:N 要搬成共用的 ecdict:N，不然在 tier-1 練會看不到既有進度
const srsKeys = await page.evaluate(() =>
  Object.keys(JSON.parse(localStorage.getItem('speaking-coach:srs') ?? '{}')));
check('band 的舊進度搬到 ecdict 命名空間',
  srsKeys.includes('ecdict:1') && !srsKeys.some((k) => k.startsWith('band-')),
  srsKeys.slice(0, 3).join(', '));
check('精選的進度沒有被搬走', srsKeys.includes('curated:1'));
check('搬完之後在分級裡看得到既有進度',
  (await text('.srsstat--mastered .srsstat__value')) !== '0',
  `已熟練 ${await text('.srsstat--mastered .srsstat__value')}`);
await shot(page, 'ui-10-單字分級');

// 選難度的畫面
await page.locator('#view button', { hasText: '換難度' }).first().click();
await page.waitForTimeout(300);
check('六個難度都選得到', (await page.locator('.deckitem').count()) === 7,
  `${await page.locator('.deckitem').count()} 個（六級 + 精選）`);
check('詞頻級距預設收起來', !(await viewText()).includes('第 9,001–10,000 常用'));
check('每一級都有進度條', (await page.locator('.deckitem .tierbar').count()) === 6);
check('練過的那一級寫出實際張數而不是 0%',
  /已熟練 \d+・學習中 \d+/.test(await viewText()) && !(await viewText()).includes('0% 碰過'));
check('沒練過的那一級寫「還沒開始」', (await viewText()).includes('還沒開始'));
await shot(page, 'ui-11-選難度');

await page.locator('#view button', { hasText: '展開' }).click();
await page.waitForTimeout(300);
check('展開後十個詞頻級距也選得到', (await page.locator('.deckitem').count()) === 17,
  `${await page.locator('.deckitem').count()} 個`);

await page.locator('.deckitem', { hasText: '高階' }).click();
await page.waitForTimeout(600);
check('換級之後標題跟著換', (await text('.deckbar')).includes('第 4 級'));
check('選的難度記在設定裡', (await page.evaluate(() =>
  JSON.parse(localStorage.getItem('speaking-coach:settings')).vocabDeck)) === 'tier-4');

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【12】單字卡：每日目標');

// 每日目標設 3，把一整天走完。
// 題型固定成翻卡：這一段驗的是「每日目標」，不該因為選擇題抽到什麼而時好時壞。
await seed({
  mode: 'vocabulary',
  settings: { vocabDeck: 'tier-1', dailyGoals: { vocabulary: 3 }, vocabQuizTypes: [] },
});
await page.waitForSelector('.card--today');

for (let i = 0; i < 3; i++) {
  await page.locator('#view button', { hasText: '顯示答案' }).click();
  await page.waitForTimeout(120);
  await page.locator('#view button', { hasText: i % 2 ? '還不熟' : '記得' }).click();
  await page.waitForTimeout(200);
}

check('練滿之後今天的進度是滿的', (await text('.card--today')).includes('3 / 3'),
  (await text('.card--today')).replace(/\s+/g, ' '));
check('連續天數從 0 變成 1', (await text('.today__block--streak .today__value')) === '1');
check('告訴使用者今天完成了', (await viewText()).includes('今天的 3 個字練完了'));
check('答對答錯都算進今天的份', (await page.evaluate(() =>
  Object.values(JSON.parse(localStorage.getItem('speaking-coach:activity') ?? '{}').vocabulary ?? {})[0])) === 3);
await shot(page, 'ui-12-每日目標');

// 這是每日目標跟舊的「一輪最多幾張」最重要的差別
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.card--today');
check('關掉重開，今天的份不會重來',
  (await viewText()).includes('今天的 3 個字練完了') && (await text('.card--today')).includes('3 / 3'));

// 不擋著不讓練 —— 目標是拿來知道自己完成了，不是拿來鎖門的
await page.locator('#view button', { hasText: '再多練' }).click();
await page.waitForTimeout(400);
check('想繼續練還是可以', (await text('.counter')).trim() === '1 / 10',
  (await text('.counter')).trim());

// 換一級之後今天練過的數字要留著（計數表記的是日期，不是牌組）
await page.locator('#view button', { hasText: '換難度' }).first().click();
await page.waitForTimeout(300);
await page.locator('.deckitem', { hasText: '進階' }).click();
await page.waitForTimeout(700);
check('換難度不會把今天的進度歸零', (await text('.card--today')).includes('3 / 3'));

// 設定頁改得到那個數字
await seed({ mode: 'settings', settings: { dailyGoals: { vocabulary: 20 } } });
const goalChips = page.locator('.card', { hasText: '每日目標' })
  .locator('.field', { hasText: '單字卡' }).locator('button');
check('設定頁有每日單字數', (await goalChips.count()) === 4);
await goalChips.nth(2).click();
await page.waitForTimeout(200);
const savedGoal = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('speaking-coach:settings')).dailyGoals.vocabulary);
check('改得動而且存得起來', savedGoal === 30, String(savedGoal));
check('五個模式都設得到目標',
  (await page.locator('.card', { hasText: '每日目標' }).locator('.field').count()) === 5);

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【13】單字卡：選擇題');

const tier1 = await fetch(`${BASE}/api/vocabulary/tier-1.json`).then((r) => r.json());
const meaningOf = (word) => firstSense(tier1.find((c) => c.word === word)?.meaning_zh);

// 固定成「看英文選中文」，這樣測試知道正確答案是哪一個字串
await seed({ mode: 'vocabulary', settings: { vocabDeck: 'tier-1', dailyGoals: { vocabulary: 20 }, vocabQuizTypes: ['en2zh'] } });
await page.waitForSelector('.quiz__options');

check('出的是選擇題', (await text('.card__meta .chip')).includes('看英文選中文'));
check('四個選項', (await page.locator('.quiz__option').count()) === 4);
check('沒作答前不標紅標綠', (await page.locator('.quiz__option--correct').count()) === 0);

// 故意答錯：挑一個不是正確答案的選項
const prompt1 = (await text('.quiz__prompt')).trim();
const answer1 = meaningOf(prompt1);
check('題目是字庫裡的字', Boolean(answer1), `${prompt1} → ${answer1}`);
const options1 = await page.locator('.quiz__option').allTextContents();
check('正確答案在選項裡', options1.map((o) => o.trim()).includes(answer1), options1.join(' / '));
check('選項沒有重複', new Set(options1.map((o) => o.trim())).size === 4, options1.join(' / '));

check('作答前不先講其他選項是什麼字（會洩題）', (await page.locator('.quiz__other').count()) === 0);

const wrongPick = options1.map((o) => o.trim()).find((o) => o !== answer1);
await page.locator('.quiz__option', { hasText: wrongPick }).first().click();
await page.waitForTimeout(250);
check('答錯時說出正確答案', (await text('.card__title')).includes(`正確答案是「${answer1}」`),
  await text('.card__title'));
check('答錯時同時標出正確答案與自己選的',
  (await page.locator('.quiz__option--correct').count()) === 1 &&
  (await page.locator('.quiz__option--wrong').count()) === 1);
check('答完之後不能再改答案', await page.locator('.quiz__option').first().isDisabled());

// 答完之後另外三個選項也講清楚是哪個字、什麼意思，順便可以聽
check('答完之後列出另外三個選項', (await page.locator('.quiz__other').count()) === 3,
  `${await page.locator('.quiz__other').count()} 個`);
const otherWords = (await page.locator('.quiz__other-word').allTextContents()).map((w) => w.trim());
check('其他選項列的是英文字（英→中 的選項本身是中文）',
  otherWords.every((w) => /^[a-zA-Z' -]+$/.test(w)), otherWords.join(' / '));
check('正確答案不重複列一次', !otherWords.includes(prompt1), otherWords.join(' / '));
check('其他選項都有音標', (await page.locator('.quiz__other-ipa').count()) === 3);
check('其他選項都有中文意思',
  (await page.locator('.quiz__other-meaning').allTextContents()).every((m) => /[\u4e00-\u9fff]/.test(m)),
  (await page.locator('.quiz__other-meaning').allTextContents()).join(' / '));
check('標出自己選錯的是哪一個', (await page.locator('.quiz__other--picked').count()) === 1);
check('標出來的那一列就是剛剛按下去的選項',
  (await text('.quiz__other--picked .quiz__other-meaning')).startsWith(wrongPick),
  `${await text('.quiz__other--picked .quiz__other-meaning')} vs ${wrongPick}`);
if (await page.evaluate(() => 'speechSynthesis' in window)) {
  check('每個選項配一顆發音鍵', (await page.locator('.quiz__other-speak').count()) === 3);
}
check('答錯的卡回到第 1 盒', (await page.evaluate(() =>
  Object.values(JSON.parse(localStorage.getItem('speaking-coach:srs')))[0].box)) === 1);
await shot(page, 'ui-13-選擇題');

await page.locator('#view button', { hasText: '下一題' }).click();
await page.waitForTimeout(300);
check('換下一題', (await text('.counter')).trim() === '2 / 20');

// 答對
const prompt2 = (await text('.quiz__prompt')).trim();
await page.locator('.quiz__option', { hasText: meaningOf(prompt2) }).first().click();
await page.waitForTimeout(250);
check('答對時說答對了', (await text('.card__title')).includes('答對了'));
check('答對不標紅', (await page.locator('.quiz__option--wrong').count()) === 0);
check('答對的卡進到第 2 盒', (await page.evaluate(() =>
  Object.values(JSON.parse(localStorage.getItem('speaking-coach:srs'))).some((s) => s.box === 2))));
check('選擇題也算進今天的份', (await text('.card--today')).includes('2 / 20'),
  (await text('.card--today')).replace(/\s+/g, ' ').slice(0, 20));

// 中→英：題目換成中文、選項是英文，而且不先播發音（會直接洩題）
await seed({ mode: 'vocabulary', settings: { vocabDeck: 'tier-1', vocabQuizTypes: ['zh2en'] } });
await page.waitForSelector('.quiz__options');
check('中→英：題目是中文', /[\u4e00-\u9fff]/.test(await text('.quiz__prompt')), await text('.quiz__prompt'));
check('中→英：選項是英文', (await page.locator('.quiz__option').allTextContents())
  .every((o) => /^[a-zA-Z' -]+$/.test(o.trim())),
  (await page.locator('.quiz__option').allTextContents()).join(' / '));
check('中→英：作答前沒有發音鍵（會洩題）',
  !(await viewText()).includes('唸這個字') || (await viewText()).indexOf('唸這個字') > (await viewText()).indexOf('下一題'));

// 中→英 答完之後，另外三個英文選項也給意思
await page.locator('.quiz__option').first().click();
await page.waitForTimeout(250);
check('中→英：答完也列出其他選項的意思',
  (await page.locator('.quiz__other').count()) === 3 &&
  (await page.locator('.quiz__other-meaning').allTextContents()).every((m) => /[\u4e00-\u9fff]/.test(m)),
  (await page.locator('.quiz__other-meaning').allTextContents()).join(' / '));
await shot(page, 'ui-13-其他選項');

// 一種都沒勾就退回翻卡，不是整個不能用
await seed({ mode: 'vocabulary', settings: { vocabDeck: 'tier-1', vocabQuizTypes: [] } });
await page.waitForSelector('#view .card');
check('一種都沒勾就退回翻卡',
  (await viewText()).includes('顯示答案') && (await page.locator('.quiz__options').count()) === 0);

// ── 釋義截斷 ─────────────────────────────────────────────────────────────
// 把 go（tier-1 的第 2 個字，20 個義項、69 個字）設成「到期要複習」，
// buildQueue 就會把它排在最前面 —— 抽到哪張卡是隨機的，這一段需要指定的字。
await seed({
  mode: 'vocabulary',
  settings: { vocabDeck: 'tier-1', vocabQuizTypes: [] },
  srs: { 'ecdict:2': { box: 1, due: Date.now() - 1000, seen: 1 } },
});
await page.waitForSelector('.vocab__word');
check('到期的卡排在最前面', (await text('.vocab__word')) === 'go', await text('.vocab__word'));

await page.locator('#view button', { hasText: '顯示答案' }).click();
await page.waitForTimeout(200);
const shortMeaning = await text('.vocab__meaning');
check('釋義先給前 4 個義項', shortMeaning === '去、走、達到、運轉', shortMeaning);
check('多的收在「看全部」後面',
  (await page.locator('#view button', { hasText: '看全部 20 個義項' }).count()) === 1);

await page.locator('#view button', { hasText: '看全部' }).click();
await page.waitForTimeout(200);
check('看全部攤開的是原本的釋義（保留分行與領域標記）',
  (await text('.vocab__meaning')).startsWith('去, 走, 達到'), (await text('.vocab__meaning')).slice(0, 20));
check('攤開之後按鈕就收起來', (await page.locator('#view button', { hasText: '看全部' }).count()) === 0);

// 短的釋義不要多一顆按鈕：say 有 7 個義項但只有 20 個字，本來就一行放得下
await seed({
  mode: 'vocabulary',
  settings: { vocabDeck: 'tier-1', vocabQuizTypes: [] },
  srs: { 'ecdict:1': { box: 1, due: Date.now() - 1000, seen: 1 } },
});
await page.waitForSelector('.vocab__word');
await page.locator('#view button', { hasText: '顯示答案' }).click();
await page.waitForTimeout(200);
check('短的釋義不截斷', (await page.locator('#view button', { hasText: '看全部' }).count()) === 0 &&
  (await text('.vocab__meaning')).includes('發言權'), await text('.vocab__meaning'));

// 設定頁勾得動
await seed({ mode: 'settings', settings: { vocabQuizTypes: ['zh2en', 'en2zh'] } });
const typeChips = page.locator('.field', { hasText: '單字卡的題型' }).locator('button');
check('設定頁有三種題型', (await typeChips.count()) === 3);
check('預設兩種選擇題是開的',
  (await typeChips.nth(0).getAttribute('class')).includes('togglechip--on') &&
  (await typeChips.nth(1).getAttribute('class')).includes('togglechip--on'));
await typeChips.nth(0).click();
await page.waitForTimeout(200);
check('取消得掉', (await page.evaluate(() =>
  JSON.parse(localStorage.getItem('speaking-coach:settings')).vocabQuizTypes)).join() === 'en2zh');

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【14】備份與還原');

// 這一段是真的走完一輪：下載 → 把資料清掉 → 用下載的檔案還原回來。
// 只驗「按鈕在」沒有意義 —— 備份唯一重要的是**還原真的救得回來**。
await seed({
  mode: 'settings',
  settings: { dailyGoals: { vocabulary: 30 }, vocabDeck: 'tier-2' },
  srs: { 'ecdict:1': { box: 5, due: 1, seen: 6, correct: 6 }, 'ecdict:2': { box: 2, due: 1, seen: 2, correct: 1 } },
  activity: { vocabulary: { '2026-09-04': 20, '2026-09-05': 12 } },
  history: fakeHistory([[0, 88, 0]]),
});
await page.waitForSelector('#backup-download');

const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('#backup-download').click(),
]);
const backupPath = `${os.tmpdir()}/speaking-coach-ui-backup.json`;
await download.saveAs(backupPath);

check('備份檔名是 ASCII 而且有副檔名',
  /^speaking-coach-backup-\d{8}\.json$/.test(download.suggestedFilename()),
  download.suggestedFilename());

const backupJson = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
// srsVersion 不在必備清單裡：它只在真的搬過鍵之後才寫得出來，
// 而搬家是冪等的、每次載入都會跑，所以沒有它也還原得回去。
const backupKeys = Object.keys(backupJson.data);
check('備份帶走四種進度資料',
  ['srs', 'activity', 'history', 'settings'].every((k) => backupKeys.includes(k)),
  backupKeys.join());
check('備份沒有夾帶白名單以外的鍵',
  backupKeys.every((k) => ['srs', 'srsVersion', 'activity', 'vocabDays', 'history', 'settings'].includes(k)),
  backupKeys.join());
check('備份裡沒有金鑰', !JSON.stringify(backupJson).includes('AIza'));
check('下載後畫面說出帶走了什麼', (await viewText()).includes('已下載'));

// 把資料清掉，再用剛剛那個檔案救回來
await seed({ mode: 'settings', settings: { dailyGoals: { vocabulary: 5 } } });
check('清空後真的是空的', (await viewText()).includes('單字卡進度：0 張'));

page.once('dialog', (d) => {
  check('覆蓋前講清楚用什麼覆蓋', d.message().includes('單字進度 2 個字'), d.message().split('\n')[0]);
  d.accept();
});
await page.locator('#backup-file').setInputFiles(backupPath);
await page.waitForTimeout(1200);          // 還原之後會重新整理

check('還原救回複習進度', (await viewText()).includes('單字卡進度：2 張'),
  (await viewText()).match(/單字卡進度：\d+ 張/)?.[0] ?? '找不到那行字');
check('還原救回偏好設定', (await page.evaluate(() =>
  JSON.parse(localStorage.getItem('speaking-coach:settings')).dailyGoals.vocabulary)) === 30);
check('還原救回每日紀錄', (await page.evaluate(() =>
  Object.keys(JSON.parse(localStorage.getItem('speaking-coach:activity') ?? '{}').vocabulary ?? {}).length)) === 2);
await shot(page, 'ui-14-備份');

// 壞掉的檔案要擋下來，而且**不能動到現有資料**
const badPath = `${os.tmpdir()}/speaking-coach-ui-bad.json`;
fs.writeFileSync(badPath, JSON.stringify({ app: 'anki', version: 1, data: { srs: {} } }));
await page.locator('#backup-file').setInputFiles(badPath);
await page.waitForTimeout(500);
check('別的 App 的檔案被擋下來', (await viewText()).includes('還原失敗'));
check('被擋下來時現有資料原封不動', (await viewText()).includes('單字卡進度：2 張'));

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【15】清除紀錄');

await seed({ history: fakeHistory([[0, 42, 0], [1, 88, 1]]) });
page.once('dialog', (d) => d.accept());
await page.locator('#view button', { hasText: '清除所有紀錄' }).click();
await page.waitForTimeout(400);
check('紀錄清單清空', (await page.locator('.history__item').count()) === 0);
check('趨勢圖收起來', (await page.locator('.trend').count()) === 0);
check('成績 chip 收起來', (await page.locator('.chip--past').count()) === 0);
// 清「跟讀紀錄」清的是成績，不是「有沒有回來練」—— 連續天數留著是刻意的，
// 要清那個得去設定頁按「清除每日紀錄」（下面那一段）
check('連續天數不會被清成績一起清掉', !(await text('.today__value')).startsWith('0 /'),
  (await text('.card--today')).replace(/\s+/g, ' ').slice(0, 24));

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【16】三個模式的每日進度');

// 舊資料只有跟讀紀錄與單字的 vocabDays 時，App 要自己生出計數表 ——
// 不然改版之後既有使用者的連續天數會歸零
await seed({ mode: 'listening', history: fakeHistory([[0, 80, 0], [1, 90, 1]]) });
await page.evaluate(() => {
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  localStorage.setItem('speaking-coach:vocabDays', JSON.stringify({ [key]: 12 }));
  localStorage.removeItem('speaking-coach:activity');
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.card--today');

const activityOf = () => page.evaluate(() =>
  JSON.parse(localStorage.getItem('speaking-coach:activity') ?? '{}'));
const built = await activityOf();
check('舊的 vocabDays 搬進計數表', Object.values(built.vocabulary ?? {})[0] === 12,
  JSON.stringify(built.vocabulary));
check('跟讀紀錄也數成每天幾句', Object.keys(built.shadowing ?? {}).length === 2,
  JSON.stringify(built.shadowing));

// 聽力：一組答完照題數算
check('聽力有今天的進度卡', (await text('.card--today')).includes('今天練的題'));
await page.evaluate(() => {
  const seen = new Set();
  document.querySelectorAll('#view .option').forEach((el) => {
    if (seen.has(el.parentElement)) return;
    seen.add(el.parentElement);
    el.click();
  });
});
await page.locator('#view button', { hasText: '對答案' }).click();
await page.waitForTimeout(300);
const listened = Object.values((await activityOf()).listening ?? {})[0];
check('聽力照題數記進今天的份', listened > 0, `${listened} 題`);
check('聽力的今天進度跟著動', (await text('.card--today')).startsWith(`${listened} /`),
  (await text('.card--today')).replace(/\s+/g, ' ').slice(0, 20));
await shot(page, 'ui-16-聽力進度');

// 中翻英：一題只算一次
await seed({ mode: 'translation' });
await page.waitForSelector('.card--today');
await page.fill('#answer', 'this is my answer');
await page.locator('#view button', { hasText: '對答案' }).click();
await page.waitForTimeout(250);
check('中翻英答一題記一題', (await text('.card--today')).startsWith('1 /'),
  (await text('.card--today')).replace(/\s+/g, ' ').slice(0, 16));
await page.locator('#view button', { hasText: '再試一次' }).click();
await page.waitForTimeout(150);
await page.locator('#view button', { hasText: '對答案' }).click();
await page.waitForTimeout(250);
check('「再試一次」不會重複計一次', (await text('.card--today')).startsWith('1 /'),
  (await text('.card--today')).replace(/\s+/g, ' ').slice(0, 16));

// 情境對話：對方的台詞不算自己的練習量
await seed({ mode: 'dialogue' });
await page.waitForSelector('.card--today');
check('對話有今天的進度卡', (await text('.card--today')).includes('今天說的台詞'));
const partnerButton = page.locator('#view button', { hasText: '換我說' });
if (await partnerButton.count()) {
  await partnerButton.click();
  await page.waitForTimeout(250);
}
check('對方講的那句不算進度', (await text('.card--today')).startsWith('0 /'),
  (await text('.card--today')).replace(/\s+/g, ' ').slice(0, 16));

// 清除每日紀錄（連續天數唯一清得掉的地方）
await seed({ mode: 'settings', activity: { vocabulary: { '2026-09-04': 20, '2026-09-05': 12 } } });
await page.waitForSelector('.card', { hasText: '學習資料' });
check('學習資料寫出有幾天的紀錄', (await viewText()).includes('每日紀錄：2 天'));
page.once('dialog', (d) => d.accept());
await page.locator('#view button', { hasText: '清除每日紀錄' }).click();
await page.waitForTimeout(300);
check('清得掉每日紀錄', (await viewText()).includes('每日紀錄：0 天'));

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【17】首頁：今天該做什麼');

const todayKey = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 單字達標、聽力一半、跟讀今天還沒練（但昨天有）
await seed({
  mode: 'home',
  activity: {
    vocabulary: { [todayKey(0)]: 20, [todayKey(1)]: 20 },
    listening: { [todayKey(0)]: 3 },
    shadowing: { [todayKey(1)]: 5 },
  },
  srs: {
    'ecdict:1': { box: 2, due: Date.now() - 1000 },
    'ecdict:2': { box: 3, due: Date.now() - 1000 },
    'ecdict:3': { box: 1, due: Date.now() + 9e6 },
  },
});
await page.waitForSelector('.homelist');

check('五個練習模式各一列', (await page.locator('.homerow').count()) === 5);
check('今天的總數是跨模式加起來的', (await text('.today__value')) === '23',
  await text('.today__value'));
// 昨天練單字、今天練聽力，沒有斷 —— 連續天數不能只看單一模式
check('連續天數是「任何一個模式有練就算」',
  (await text('.today__block--streak .today__value')) === '2',
  await text('.today__block--streak .today__value'));
check('達標的那一列打勾', (await page.locator('.homerow--done').count()) === 1);
check('沒達標的講還差多少', (await viewText()).includes('還差 10 題'));
check('待複習只數到期的那幾個', (await viewText()).includes('有 2 個字到期了'), await viewText());
await shot(page, 'ui-17-首頁');

// 點一列會跳到那個模式
await page.locator('.homerow', { hasText: '聽力' }).click();
await page.waitForTimeout(600);
check('點一列會跳過去', (await page.evaluate(() =>
  localStorage.getItem('speaking-coach:mode'))) === 'listening');
check('跳過去之後畫的是那個模式', (await viewText()).includes('先聽，再作答'));

// 全部達標的樣子
await seed({
  mode: 'home',
  activity: {
    vocabulary: { [todayKey(0)]: 20 }, listening: { [todayKey(0)]: 6 },
    translation: { [todayKey(0)]: 10 }, dialogue: { [todayKey(0)]: 6 },
    shadowing: { [todayKey(0)]: 5 },
  },
});
await page.waitForSelector('.homelist');
check('全部達標時說完成了', (await viewText()).includes('今天的目標都完成了'));
check('全部達標時數字變色', await page.locator('.today__value--done').isVisible());
check('五列都打勾', (await page.locator('.homerow--done').count()) === 5);

// 什麼都沒練的第一天
await seed({ mode: 'home' });
await page.waitForSelector('.homelist');
check('第一天不會像在罵人', (await viewText()).includes('今天還沒開始'), await text('.card--today .hint'));
check('沒有到期的字時也講得出話', (await viewText()).includes('目前沒有到期的字'));

// 沒設目標時不要顯示 0 / 0
await seed({
  mode: 'home',
  settings: { dailyGoals: { vocabulary: 0, listening: 0, translation: 0, dialogue: 0, shadowing: 0 } },
});
await page.waitForSelector('.homelist');
check('沒設目標時不寫成 0 / 0', !(await viewText()).includes('0 / 0'), await viewText());
check('沒設目標時指路到設定', (await viewText()).includes('設定 → 每日目標'));

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【18】JS 錯誤');
check('沒有 console error 或未捕捉例外', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${failed === 0 ? '全部通過' : `*** ${failed} 項失敗 ***`}`);
process.exit(failed === 0 ? 0 : 1);
