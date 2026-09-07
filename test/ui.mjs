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

// ─── 先登入 ──────────────────────────────────────────────────────────────
//
// 所有 /api 端點都要登入（見 server/routes-auth.js），所以測試自己要有帳號。
//
// 「先註冊，403 就改成登入」是為了兩種情境都能跑：
//   CI     每次都是全新的容器 → 沒有帳號 → 註冊成功
//   本機   重跑第二次時帳號已經在了 → 註冊回 403 → 用同一組密碼登入
// 需要伺服器指向一個乾淨的 DATA_DIR 才會是「第一個帳號」，所以這組帳密
// 只會出現在開發／CI 的伺服器上。
const TEST_USER = { username: 'uitest', password: 'ui-test-password' };

async function authenticate() {
  const post = (path, body) => fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  let res = await post('/api/auth/register', TEST_USER);
  if (!res.ok) res = await post('/api/auth/login', TEST_USER);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error(
      `測試帳號登入不了（HTTP ${res.status}）：${body.message ?? ''}\n` +
      '這台伺服器上已經有別的帳號了。請用一個乾淨的 DATA_DIR 重新啟動伺服器：\n' +
      '  DATA_DIR=$(mktemp -d) npm start'
    );
    process.exit(1);
  }
  // 同一個 cookie 要同時給 fetch（下面的預檢）與瀏覽器用
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

const cookieHeader = await authenticate();

/**
 * 打 API 一律走這裡 —— 每一個端點都要登入，漏帶 cookie 的話拿到的是 401 的
 * JSON 物件而不是預期的陣列，症狀會是「`.find` is not a function」這種
 * 完全看不出原因的錯（真的踩過）。
 */
const apiGet = (path) =>
  fetch(`${BASE}${path}`, { headers: { cookie: cookieHeader } }).then((r) => r.json());

/**
 * 把伺服器上的進度清成「什麼都沒練過」。【22】用。
 *
 * 【22】驗的是絕對數字（兩台各練 N → 總和是 N+M），所以伺服器上不可以留著
 * **上一次跑測試**留下的今日計數 —— 同一個 `DATA_DIR` 重跑第二次時，
 * 上一輪那兩台裝置的格子會被合併進來，症狀是四條測試同時說數字變成兩倍，
 * 看起來像合併寫錯了（真的踩過，而且第一眼完全不像測試自己的問題）。
 *
 * 走的是「整包覆蓋」那個端點 —— 它就是為了覆蓋而存在的，
 * 而 `POST /merge` 的語意是合併，清不掉東西。
 */
async function resetServerProgress() {
  const current = await apiGet('/api/sync');
  const res = await fetch(`${BASE}/api/sync`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({
      rev: current.rev ?? 0,
      data: { srs: {}, activity: {}, history: [] },
    }),
  });
  if (!res.ok) {
    console.error(`清不掉伺服器上的進度（HTTP ${res.status}）—— 【22】的數字會不準。`);
    process.exit(1);
  }
}

const sentences = await apiGet('/api/content/sentences');
if (!Array.isArray(sentences) || sentences.length < 10) {
  console.error(`讀不到練習句，${BASE} 上的伺服器有在跑嗎？`);
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
// acceptDownloads：備份那一段會真的下載一個檔案再讀回來
const context = await browser.newContext({ acceptDownloads: true });

// 把登入的 cookie 塞進瀏覽器，其餘的測試就跟以前一樣不必管登入。
// 登入畫面本身另外有一段測（【21】）
{
  const url = new URL(BASE);
  const [name, value] = cookieHeader.split('=');
  await context.addCookies([{
    name, value, domain: url.hostname, path: '/', httpOnly: true, secure: false,
  }]);
}

const page = await context.newPage();

// TTS 的錯誤濾掉：headless 沒有安裝任何語音包，那不是 App 的問題。
//
// **404 不再濾掉了。** 以前這裡要濾掉 404 是因為沒有 favicon，完整版 Chromium
// 會為此留一筆錯誤；現在 index.html 有 `rel="icon"`（PWA 那批圖示），
// 所以 404 一律是真的問題 —— 濾掉它等於讓「某個模組路徑打錯」這種 bug 靜悄悄地過。
const errors = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() !== 'error') return;
  if (t.includes('[tts]')) return;
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
    // **把自動同步關掉。** 這些測試塞的是假的 localStorage，而自動同步會把
    // 伺服器上（前面幾段測試推上去的）東西合進來 —— 假資料就不是假資料了。
    // 跨裝置同步本身在【22】用自己的 context 測，那裡是開著的。
    localStorage.setItem('speaking-coach:autoSync', 'off');
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

// ─── 從網頁設金鑰 ────────────────────────────────────────────────────────
//
// 以前這張卡只有「從 localhost 打進來」的請求看得到（`assertLocalRequest`），
// 現在是「要登入 + 要是擁有者」。測試帳號是這台伺服器上第一個帳號，
// 所以它就是擁有者 —— 這幾條會失敗的話，第一個要懷疑的是伺服器的 DATA_DIR
// 不乾淨（uitest 變成第二個帳號，那它就不是擁有者了）。
check('擁有者看得到金鑰欄位', (await page.locator('#azure-key').count()) === 1);
check('看得到講評端點那張卡', (await page.locator('#narration-base-url').count()) === 1);
check('講評來源四個選項都在', (await page.locator('#narration-provider option').count()) === 4);
check('金鑰卡寫出「現在」用的是哪一條路',
  (await page.locator('.card', { hasText: 'API 金鑰' }).textContent()).includes('目前'));

// 真的存一次 —— 這是這一版唯一重要的事，「按鈕在」不算。
// 存完再清掉，不要把值留在開發／CI 的伺服器上
// 用「裡面有那個欄位的卡」來抓，不要用 hasText —— 練習偏好那張卡的說明文字
// 裡也寫著「講評端點」，hasText 會同時抓到兩張（踩過）
const narrationCard = page.locator('.card', { has: page.locator('#narration-base-url') });

/** 按「儲存講評端點」，等畫面真的說存好了。等訊息而不是睡 600 毫秒 —— 睡會 flaky。 */
async function saveNarrationModel(value) {
  await page.locator('#narration-model').fill(value);
  await page.locator('button', { hasText: '儲存講評端點' }).click();
  return narrationCard.getByText('已儲存').first()
    .waitFor({ timeout: 5000 }).then(() => true, () => false);
}

check('存了會說立即生效', await saveNarrationModel('ui-test-model'));
check('伺服器真的收到了',
  (await apiGet('/api/settings')).NARRATION_MODEL?.value === 'ui-test-model',
  (await apiGet('/api/settings')).NARRATION_MODEL?.value);

check('清掉也清得回去', (await saveNarrationModel('')) &&
  (await apiGet('/api/settings')).NARRATION_MODEL?.value === '');

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
check('答對答錯都算進今天的份', (await page.evaluate(() => {
  const days = JSON.parse(localStorage.getItem('speaking-coach:activity') ?? '{}').vocabulary ?? {};
  const first = Object.values(days)[0];
  return first && typeof first === 'object'
    ? Object.values(first).reduce((x, y) => x + y, 0)
    : Number(first) || 0;
})) === 3);
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

const tier1 = await apiGet('/api/vocabulary/tier-1.json');
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

/**
 * 某個模式第一天的數字。
 *
 * 計數表是「一天一格、每台裝置各一格」（跨裝置合併用，見 lib/merge.js），
 * 所以要把格子加起來 —— 直接讀原始值會拿到 `[object Object]`。
 * 舊形狀（一天一個數字）也要讀得懂，`getActivity()` 對還沒搬過的資料就是那樣。
 */
const dayTotal = (days) => {
  const first = Object.values(days ?? {})[0];
  if (first && typeof first === 'object') {
    return Object.values(first).reduce((x, y) => x + (Number(y) || 0), 0);
  }
  return Number(first) || 0;
};
const built = await activityOf();
// 搬進去的是固定的 `legacy` 格，**不是本機那一格** ——
// 兩台裝置各搬一次的話，同一段歷史會被算成兩台的份而加倍
check('舊的 vocabDays 搬進計數表的 legacy 格', dayTotal(built.vocabulary) === 12
  && Object.keys(Object.values(built.vocabulary)[0])[0] === 'legacy',
  JSON.stringify(built.vocabulary));
check('跟讀紀錄也數成每天幾句', Object.keys(built.shadowing ?? {}).length === 2,
  JSON.stringify(built.shadowing));

// 聽力：**一組算一次**，不是照題數算。
// 一組有 2～6 題，照題數算的話同樣練完一組、數字跳多少要看運氣。
const answerWholeSet = async () => {
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
};
const listeningCount = async () => dayTotal((await activityOf()).listening);

check('聽力有今天的進度卡', (await text('.card--today')).includes('今天練的題組'));
const questionsInSet = await page.locator('#view .question').count();
await answerWholeSet();
const listened = await listeningCount();
check('聽力一組只算一次，不是照題數算', listened === 1,
  `這一組有 ${questionsInSet} 題，記了 ${listened}`);
check('聽力的今天進度跟著動', (await text('.card--today')).startsWith(`${listened} /`),
  (await text('.card--today')).replace(/\s+/g, ' ').slice(0, 20));

// 「再做一次」是重練同一組，不是又練完一組 —— 中翻英的「再試一次」是同一條規則
await page.locator('#view button', { hasText: '再做一次' }).click();
await page.waitForTimeout(200);
await answerWholeSet();
check('聽力「再做一次」同一組不重複算', (await listeningCount()) === 1,
  `變成 ${await listeningCount()}`);

await page.locator('#view button', { hasText: '下一題' }).click();
await page.waitForTimeout(400);
await answerWholeSet();
check('聽力換一組答完才會再加一次', (await listeningCount()) === 2,
  `變成 ${await listeningCount()}`);
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
// 聽力的目標是 2 組（單位是「組」不是「題」），所以「一半」是 1
await seed({
  mode: 'home',
  activity: {
    vocabulary: { [todayKey(0)]: 20, [todayKey(1)]: 20 },
    listening: { [todayKey(0)]: 1 },
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
check('今天的總數是跨模式加起來的', (await text('.today__value')) === '21',
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
console.log('\n【18】鍵盤操作');

// 單字卡的選擇題：數字鍵選答案、Enter 下一題
await seed({
  mode: 'vocabulary',
  settings: { vocabDeck: 'tier-1', vocabQuizTypes: ['en2zh'], dailyGoals: { vocabulary: 20 } },
  srs: { 'ecdict:1': { box: 1, due: Date.now() - 1000, seen: 1 } },
});
await page.waitForSelector('.quiz__options');
await page.keyboard.press('1');
await page.waitForTimeout(250);
const firstClass = await page.locator('.quiz__option').first().getAttribute('class');
check('按 1 選的是第一個選項',
  firstClass.includes('quiz__option--correct') || firstClass.includes('quiz__option--wrong'), firstClass);
check('鍵盤作答也算進今天的份', (await text('.card--today')).includes('1 / 20'),
  (await text('.card--today')).replace(/\s+/g, ' ').slice(0, 12));

await page.keyboard.press('Enter');
await page.waitForTimeout(300);
check('Enter 換下一題', (await text('.counter')).trim() === '2 / 20', (await text('.counter')).trim());

// 翻卡：空白鍵翻開、1 是「還不熟」
await seed({
  mode: 'vocabulary',
  settings: { vocabDeck: 'tier-1', vocabQuizTypes: [], dailyGoals: { vocabulary: 20 } },
  srs: { 'ecdict:1': { box: 3, due: Date.now() - 1000, seen: 5 } },
});
await page.waitForSelector('.vocab__word');
await page.keyboard.press('Space');
await page.waitForTimeout(200);
check('空白鍵翻卡', (await viewText()).includes('剛剛記得嗎'));
await page.keyboard.press('1');
await page.waitForTimeout(250);
check('翻卡按 1 是「還不熟」（回到第 1 盒）',
  (await page.evaluate(() => JSON.parse(localStorage.getItem('speaking-coach:srs'))['ecdict:1'].box)) === 1);

// 正在打字的時候不接快捷鍵 —— 不擋的話打一個 n 就換題，答案直接消失
await seed({ mode: 'translation' });
await page.waitForSelector('#answer');
const beforeTyping = await text('.trans__zh');
await page.locator('#answer').click();
await page.keyboard.type('no news');
await page.waitForTimeout(200);
check('打字中的 N 不會換題', (await text('.trans__zh')) === beforeTyping);
check('打的字留在輸入框裡', (await page.locator('#answer').inputValue()) === 'no news');

// 聽力：數字鍵答的是「還沒作答的第一題」，Enter 對答案
await seed({ mode: 'listening' });
await page.waitForSelector('.options');
const questionCount = await page.locator('.question').count();
for (let i = 0; i < questionCount; i++) await page.keyboard.press('1');
await page.waitForTimeout(250);
check('數字鍵由上往下答', (await page.locator('.option--chosen').count()) === questionCount,
  `${await page.locator('.option--chosen').count()} / ${questionCount}`);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
check('Enter 對答案', (await viewText()).includes('答對'));

// 跟讀：N 換一句（空白鍵的錄音沒辦法在無麥克風的環境驗，見 e2e.mjs）
await seed({ mode: 'shadowing' });
await page.waitForSelector('#sentence');
const before = await text('#sentence');
await page.keyboard.press('n');
await page.waitForTimeout(300);
check('跟讀按 N 換一句', (await text('#sentence')) !== before,
  `${before.slice(0, 20)} → ${(await text('#sentence')).slice(0, 20)}`);

// 首頁：1–5 跳到那個模式
await seed({ mode: 'home' });
await page.waitForSelector('.homelist');
await page.keyboard.press('2');
await page.waitForTimeout(600);
check('首頁按 2 跳到聽力', (await text('#pageTitle')).includes('聽力'), await text('#pageTitle'));

// 側欄要講出有哪些鍵可以按 —— 快捷鍵最大的問題是沒人知道有這個東西
check('側欄有快捷鍵提示', (await page.locator('#railKeys .kbd').count()) > 0);
check('提示跟著模式換', (await page.textContent('#railKeys')).includes('換一題'),
  await page.textContent('#railKeys'));
await seed({ mode: 'settings' });
check('設定頁沒有快捷鍵就不畫那一區', await page.locator('#railKeys').isHidden());
await shot(page, 'ui-18-鍵盤');

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【19】PWA：加到主畫面與離線');

const manifest = await page.evaluate(async () => {
  const href = document.querySelector('link[rel=manifest]')?.href;
  if (!href) return null;
  const res = await fetch(href);
  return res.ok ? res.json() : null;
});
check('manifest 載得到而且是合法 JSON', Boolean(manifest?.name), manifest?.name ?? '（沒有）');
check('display 是 standalone（加到主畫面才不會有網址列）', manifest?.display === 'standalone');

const swState = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return { active: Boolean(reg?.active), controlled: Boolean(navigator.serviceWorker.controller) };
});
check('service worker 裝起來了', swState.active);
check('頁面由 service worker 控制', swState.controlled);

// 真的斷線試一次 —— 這是 PWA 唯一重要的問題：關掉網路還打不打得開
await seed({ mode: 'vocabulary', settings: { vocabDeck: 'tier-1', vocabQuizTypes: [] } });
await page.waitForSelector('.vocab__word');
await page.waitForTimeout(800);   // 讓字庫進到快取

await context.setOffline(true);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
check('離線也打得開', (await page.locator('#view .card').count()) > 0,
  `${await page.locator('#view .card').count()} 張卡`);
check('離線也抽得到字（字庫在快取裡）', Boolean(await page.locator('.vocab__word').count()));
check('離線時沒有錯誤橫幅', (await page.locator('.banner--error').count()) === 0,
  await page.locator('.banner--error').count() ? await text('.banner--error') : '');
await context.setOffline(false);

const cacheNames = await page.evaluate(() => caches.keys());
check('App 與題庫分開兩個快取', cacheNames.length === 2, cacheNames.join(' | '));

// ─── Chrome 自己認不認為這個 App 裝得起來 ────────────────────────────────
//
// 上面那幾條驗的是「檔案齊不齊、內容對不對」，但**齊全不等於裝得起來** ——
// manifest 少一個必要欄位、圖示尺寸不合、start_url 掉出 scope、service worker
// 沒接管，Chrome 都會安靜地不給「安裝應用程式」那個選項，而畫面上完全看不出來。
// 與其自己重寫一份 Chrome 的判斷規則（一定會跟它的實作分岔），不如直接問它：
// CDP 的 `Page.getInstallabilityErrors` 回的就是 Chrome 自己列的阻礙清單。
//
// **一定要用 persistent context。** 一般的 Playwright context 是無痕模式，
// Chrome 在無痕下一律回 `in-incognito`，那條會蓋掉所有其他原因 ——
// 看起來像「有一個阻礙」，其實是測試自己造成的。
{
  const dir = fs.mkdtempSync(`${os.tmpdir()}/pwa-profile-`);
  const persistent = await chromium.launchPersistentContext(dir, {
    executablePath: process.env.CHROMIUM || undefined,
  });
  try {
    const p2 = await persistent.newPage();
    await p2.goto(BASE, { waitUntil: 'networkidle' });
    await p2.waitForTimeout(2000);

    const cdp = await persistent.newCDPSession(p2);
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    check('Chrome 沒有列出任何安裝阻礙', installabilityErrors.length === 0,
      installabilityErrors.map((e) => e.errorId).join(' | ') || '（0 項）');

    const { errors: manifestErrors } = await cdp.send('Page.getAppManifest');
    check('manifest 沒有解析錯誤', manifestErrors.length === 0,
      manifestErrors.map((e) => e.message).join(' | ') || '（0 項）');

    // ⚠️ **刻意不驗 `beforeinstallprompt` 有沒有發。**
    //
    // 那個事件除了「符合安裝條件」之外還要看 Chrome 的使用者互動熱度
    // （engagement heuristics）與版本，所以在 CI 上不會發 —— 本機全過、
    // CI 紅，而 App 本身完全沒問題。`getInstallabilityErrors` 給的是同一件事
    // 而且是確定的（上面那條），這裡再驗一次只是換來一條會無故變紅的測試。
  } finally {
    await persistent.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【20】JS 錯誤');
check('沒有 console error 或未捕捉例外', errors.length === 0, errors.slice(0, 3).join(' | '));

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【21】登入');

// 用**自己的 context**（等於另一台裝置，沒有 cookie）——
// 上面那個 context 已經帶著登入的 cookie，看不到登入畫面。
// 而且這一段預期會有 401／400 的網路錯誤（登入畫面本來就是這樣），
// 分開之後才不會污染【20】那條「沒有 console error」
{
  const fresh = await browser.newContext();
  const p2 = await fresh.newPage();
  await p2.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.login', { timeout: 15000 });

  check('沒登入時看到的是登入畫面', await p2.locator('.login').isVisible());
  // 側欄留著的話，點下去只會拿到一連串 401，畫面看起來像壞了
  check('沒登入時側欄收起來', !(await p2.locator('.rail').isVisible()));
  const width = (await p2.locator('.login').boundingBox()).width;
  // .rail 被藏起來之後 .page 會掉進 grid 的第一欄（側欄那格）——
  // 沒有 `body.locked .shell { display: block }` 的話這裡會是 230 左右
  check('登入卡沒有被擠成一條', width > 300, `${Math.round(width)}px`);

  await p2.fill('#login-username', TEST_USER.username);
  await p2.fill('#login-password', 'definitely-the-wrong-password');
  await p2.locator('.login button[type=submit]').click();
  await p2.waitForSelector('.hint--warn', { timeout: 10000 });
  check('密碼錯了會講', (await p2.locator('.hint--warn').innerText()).includes('不對'),
    await p2.locator('.hint--warn').innerText());
  // 密碼打錯就得連帳號一起重打的話，很快就會讓人不想登入
  check('失敗之後帳號欄還留著', (await p2.inputValue('#login-username')) === TEST_USER.username);

  await p2.fill('#login-password', TEST_USER.password);
  await p2.locator('.login button[type=submit]').click();
  await p2.waitForSelector('.homelist', { timeout: 15000 });
  check('密碼對了就進 App', await p2.locator('.rail').isVisible());
  await shot(p2, 'ui-21-登入');
  await fresh.close();
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【22】跨裝置自動合併');

// 這一段是階段 B 的驗收標準：**兩台裝置各練各的，數字要等於兩邊的總和**，
// 而且**同一次合併重跑幾次數字都不變**。
//
// 用兩個獨立的 context 當兩台裝置（各自的 localStorage、各自的 deviceId），
// 而且走真的伺服器 —— 合併是在伺服器上做的，mock 掉就等於沒測到。
{
  // 伺服器上不能留著上一次跑測試的今日計數（見 `resetServerProgress()`）
  await resetServerProgress();

  const devices = [];
  const openDevice = async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.login', { timeout: 15000 });
    await p.fill('#login-username', TEST_USER.username);
    await p.fill('#login-password', TEST_USER.password);
    await p.locator('.login button[type=submit]').click();
    await p.waitForSelector('.homelist', { timeout: 15000 });
    // 等啟動時的自動同步跑完
    await p.waitForTimeout(1500);
    devices.push(ctx);
    return p;
  };

  const answerOneSet = async (p) => {
    await p.evaluate(() => localStorage.setItem('speaking-coach:mode', 'listening'));
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#view .question', { timeout: 15000 });
    await p.evaluate(() => {
      const seen = new Set();
      document.querySelectorAll('#view .option').forEach((el) => {
        if (seen.has(el.parentElement)) return;
        seen.add(el.parentElement);
        el.click();
      });
    });
    await p.locator('#view button', { hasText: '對答案' }).click();
    await p.waitForTimeout(300);
  };

  const syncNow = async (p) => {
    await p.evaluate(() => localStorage.setItem('speaking-coach:mode', 'settings'));
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#view .card', { timeout: 15000 });
    await p.locator('#view .card', { hasText: '跨裝置同步' })
      .locator('button', { hasText: '現在同步' }).click();
    await p.waitForTimeout(2000);
  };

  // 那一天所有格子的總和 —— 這就是畫面上看到的數字
  const listeningTotal = (p) => p.evaluate(() => {
    const a = JSON.parse(localStorage.getItem('speaking-coach:activity') ?? '{}');
    const days = a.listening ?? {};
    return Object.values(days).reduce((sum, slots) => sum
      + (typeof slots === 'object'
        ? Object.values(slots).reduce((x, y) => x + y, 0)
        : Number(slots) || 0), 0);
  });
  const slotCount = (p) => p.evaluate(() => {
    const a = JSON.parse(localStorage.getItem('speaking-coach:activity') ?? '{}');
    const days = Object.values(a.listening ?? {});
    return days.length ? Object.keys(days[0]).length : 0;
  });

  try {
    const one = await openDevice();
    const two = await openDevice();

    const idOf = (p) => p.evaluate(() => localStorage.getItem('speaking-coach:deviceId'));

    await answerOneSet(one);
    await answerOneSet(two);
    await answerOneSet(two);

    // 每台裝置一格 —— 同一個 id 的話兩台會互相覆蓋對方的格子
    check('兩台裝置拿到不一樣的 deviceId', (await idOf(one)) !== (await idOf(two)),
      `${await idOf(one)} / ${await idOf(two)}`);

    await syncNow(one);
    await syncNow(two);
    await syncNow(one);

    const t1 = await listeningTotal(one);
    const t2 = await listeningTotal(two);
    // 取 max 會得到 2（少算）、相加會不冪等（重跑就膨脹）
    check('兩台各練各的，合起來是總和', t1 === 3 && t2 === 3, `甲 ${t1} / 乙 ${t2}（該都是 3）`);
    check('一天兩格（各自一格，沒有互相覆蓋）', (await slotCount(one)) === 2, `${await slotCount(one)} 格`);

    // 冪等：同一次合併重跑幾次都不該變
    await syncNow(one);
    await syncNow(two);
    await syncNow(one);
    const after = await listeningTotal(one);
    check('重複同步不會讓數字膨脹', after === 3, `變成 ${after}`);

    // 全新的裝置登入之後**不用按任何按鈕**就該把進度拉下來
    const three = await openDevice();
    const t3 = await listeningTotal(three);
    check('全新裝置登入後自動拉到進度', t3 === 3, `${t3}（該是 3）`);

    await shot(three, 'ui-22-跨裝置同步');
  } finally {
    for (const ctx of devices) await ctx.close();
  }
}

await browser.close();
console.log(`\n${failed === 0 ? '全部通過' : `*** ${failed} 項失敗 ***`}`);
process.exit(failed === 0 ? 0 : 1);
