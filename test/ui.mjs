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

import { chromium } from '@playwright/test';

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
const context = await browser.newContext();
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
 * `srs` 是單字卡的複習進度，預設清空 —— 不清的話上一段測試留下的進度會讓
 * 「還沒開始」這種斷言時好時壞。
 */
async function seed({ history = [], settings = {}, mode = 'shadowing', srs = {} } = {}) {
  await page.evaluate(({ h, s, m, r }) => {
    localStorage.setItem('speaking-coach:history', JSON.stringify(h));
    localStorage.setItem('speaking-coach:settings', JSON.stringify(s));
    localStorage.setItem('speaking-coach:mode', m);
    localStorage.setItem('speaking-coach:srs', JSON.stringify(r));
    localStorage.removeItem('speaking-coach:srsVersion');
  }, { h: history, s: settings, m: mode, r: srs });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#nav .tab');
  await page.waitForTimeout(500);
}

await page.goto(BASE);
await page.waitForSelector('#nav .tab');

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【1】六個模式都載入得起來');

const tabs = await page.locator('#nav .tab').allTextContents();
check('分頁有六個', tabs.length === 6, tabs.join(' | '));

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
const catChips = await page.locator('.chips').first().locator('button').allTextContents();
check('八種情境都選得到', catChips.length === 8, catChips.join('、'));
check('三種難度都選得到', (await page.locator('.chips').nth(1).locator('button').count()) === 3);
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

await seed({ mode: 'vocabulary', settings: { vocabDeck: 'tier-1', vocabDailyGoal: 3 }, srs: legacySrs });
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

// 每日目標設 3，把一整天走完
await seed({ mode: 'vocabulary', settings: { vocabDeck: 'tier-1', vocabDailyGoal: 3 } });
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
  Object.values(JSON.parse(localStorage.getItem('speaking-coach:vocabDays') ?? '{}'))[0])) === 3);
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
await seed({ mode: 'settings', settings: { vocabDailyGoal: 20 } });
const goalChips = page.locator('.field', { hasText: '單字卡每天練幾個字' }).locator('button');
check('設定頁有每日單字數', (await goalChips.count()) === 4);
await goalChips.nth(2).click();
await page.waitForTimeout(200);
check('改得動而且存得起來', (await page.evaluate(() =>
  JSON.parse(localStorage.getItem('speaking-coach:settings')).vocabDailyGoal)) === 30,
  String(await page.evaluate(() =>
    JSON.parse(localStorage.getItem('speaking-coach:settings')).vocabDailyGoal)));

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【13】清除紀錄');

await seed({ history: fakeHistory([[0, 42, 0], [1, 88, 1]]) });
page.once('dialog', (d) => d.accept());
await page.locator('#view button', { hasText: '清除所有紀錄' }).click();
await page.waitForTimeout(400);
check('紀錄清單清空', (await page.locator('.history__item').count()) === 0);
check('趨勢圖收起來', (await page.locator('.trend').count()) === 0);
check('成績 chip 收起來', (await page.locator('.chip--past').count()) === 0);
check('今天的進度歸零', (await text('.today__value')).startsWith('0 /'));

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【14】JS 錯誤');
check('沒有 console error 或未捕捉例外', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${failed === 0 ? '全部通過' : `*** ${failed} 項失敗 ***`}`);
process.exit(failed === 0 ? 0 : 1);
