// 每天的呼叫上限：規則（server/quota.js，純函式）與計數的落地（server/store.js）。
//
// 為什麼這一份要測得細：上限寫錯有兩種症狀，而**兩種都很糟**——
// 太鬆等於沒有上限（那是加它的唯一理由），太緊會讓人在練習中間突然被擋下來，
// 而畫面上看起來就像功能壞了。而且它跟時間與檔案有關，手動很難重現。
//
// 這裡**不 import server/index.js** —— 它一 import 就 app.listen()。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_DAILY_LIMIT, parseLimit, parseLimits, limitsFromEnv,
  usageKey, judgeCall, describeBlock,
} from '../server/quota.js';
import { createStore } from '../server/store.js';

// ─── 一個上限值怎麼讀 ────────────────────────────────────────────────────

test('數字就是數字，off 那一類是「不限制」', () => {
  assert.equal(parseLimit('200'), 200);
  assert.equal(parseLimit(' 50 '), 50);
  assert.equal(parseLimit(200), 200);
  for (const raw of ['off', 'OFF', 'none', 'no', 'false', 'unlimited', '不限', '無', '-1']) {
    assert.equal(parseLimit(raw), null, `${raw} 應該是不限制`);
  }
});

test('0 是「不限制」而不是「一次都不准」', () => {
  // 「0 次」當成上限的話整個 App 直接不能用，而使用者填 0 的意思幾乎都是「別管我」
  assert.equal(parseLimit('0'), null);
});

test('看不懂的值回 undefined —— 呼叫端才有機會退回預設值並警告', () => {
  // 打錯字時靜靜變成「不限制」是最糟的結果：上限看起來設了，其實沒有
  for (const raw of ['abc', '20 次', '', '  ', undefined, null, {}]) {
    assert.equal(parseLimit(raw), undefined, `${JSON.stringify(raw)} 應該看不懂`);
  }
});

// ─── 逐模型的上限 ────────────────────────────────────────────────────────

test('model=次數，分號、逗號、換行都當分隔', () => {
  assert.deepEqual(
    parseLimits('gemini=50; openai/gpt-oss-120b:groq=500'),
    { gemini: 50, 'openai/gpt-oss-120b:groq': 500 }
  );
  assert.deepEqual(parseLimits('a=1,b=2\nc=3'), { a: 1, b: 2, c: 3 });
});

test('model id 裡的斜線與冒號不會被切壞', () => {
  // 用第一個 = 切，而 model id 裡不會有 =
  assert.deepEqual(
    parseLimits('meta-llama/Llama-3.3-70B-Instruct:cerebras=10'),
    { 'meta-llama/Llama-3.3-70B-Instruct:cerebras': 10 }
  );
});

test('某一項寫壞只略過那一項，其他照算', () => {
  assert.deepEqual(parseLimits('gemini=50; 這行沒有等號; azure=off'), { gemini: 50, azure: null });
});

test('不是字串、或空字串，都回空物件', () => {
  assert.deepEqual(parseLimits(undefined), {});
  assert.deepEqual(parseLimits(''), {});
  assert.deepEqual(parseLimits(42), {});
});

// ─── 從環境變數讀 ────────────────────────────────────────────────────────

test('沒設定時用預設值，不是「不限制」', () => {
  const limits = limitsFromEnv({});
  assert.equal(limits.total, DEFAULT_DAILY_LIMIT);
  assert.deepEqual(limits.byKey, {});
});

test('看不懂的 AI_DAILY_LIMIT 退回預設值', () => {
  assert.equal(limitsFromEnv({ AI_DAILY_LIMIT: 'abc' }).total, DEFAULT_DAILY_LIMIT);
  assert.equal(limitsFromEnv({ AI_DAILY_LIMIT: 'off' }).total, null);
  assert.equal(limitsFromEnv({ AI_DAILY_LIMIT: '30' }).total, 30);
});

// ─── 記在哪個計數上 ──────────────────────────────────────────────────────

test('有 model 就用 model id，沒有就用供應商名稱', () => {
  assert.equal(usageKey({ provider: 'gemini', model: 'gemini-3.6-flash' }), 'gemini-3.6-flash');
  assert.equal(usageKey({ provider: 'azure' }), 'azure');
  assert.equal(usageKey({}), 'unknown');
});

// ─── 放不放行 ────────────────────────────────────────────────────────────

const LIMITS = { total: 10, byKey: { 'gemini-3.6-flash': 3, azure: null } };

test('總量與逐模型「兩道都要過」', () => {
  // 總量還有空間，但這個 model 自己的額度滿了
  const modelFull = judgeCall({
    usage: { total: 5, byKey: { 'gemini-3.6-flash': 3 } },
    key: 'gemini-3.6-flash',
    provider: 'gemini',
    limits: LIMITS,
  });
  assert.equal(modelFull.allowed, false);
  assert.equal(modelFull.reason, 'key');

  // 這個 model 沒有自己的上限，但總量滿了
  const totalFull = judgeCall({
    usage: { total: 10, byKey: {} },
    key: 'some/other-model',
    provider: 'openai',
    limits: LIMITS,
  });
  assert.equal(totalFull.allowed, false);
  assert.equal(totalFull.reason, 'total');
});

test('總量先擋 —— 兩個都滿的時候要講「今天練夠了」而不是「換個模型」', () => {
  const verdict = judgeCall({
    usage: { total: 10, byKey: { 'gemini-3.6-flash': 3 } },
    key: 'gemini-3.6-flash',
    provider: 'gemini',
    limits: LIMITS,
  });
  assert.equal(verdict.reason, 'total');
  assert.match(describeBlock(verdict), /所有模式一起算/);
});

test('逐模型的上限找不到 model id 時退回供應商名稱', () => {
  // AI_DAILY_LIMITS=gemini=50 要對所有 Gemini 的 model 都成立，
  // 不然白名單裡每加一個 model 就要改設定
  const limits = { total: null, byKey: { gemini: 2 } };
  const verdict = judgeCall({
    usage: { total: 9, byKey: { 'gemini-3.7-flash': 2 } },
    key: 'gemini-3.7-flash',
    provider: 'gemini',
    limits,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.limit, 2);
});

test('某個 model 設成 off 就不受逐模型那一關限制（總量還是擋著）', () => {
  const verdict = judgeCall({
    usage: { total: 9, byKey: { azure: 999 } },
    key: 'azure',
    provider: 'azure',
    limits: LIMITS,
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.limit, null);
  // 剩幾次要看總量那一邊（10 - 9）
  assert.equal(verdict.remaining, 1);
});

test('兩邊都不限制時 remaining 是 null —— 畫面上就不寫剩幾次', () => {
  const verdict = judgeCall({
    usage: { total: 999, byKey: {} },
    key: 'x',
    limits: { total: null, byKey: {} },
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.remaining, null);
});

test('remaining 取兩邊的小的那一個', () => {
  const verdict = judgeCall({
    usage: { total: 2, byKey: { 'gemini-3.6-flash': 2 } },
    key: 'gemini-3.6-flash',
    provider: 'gemini',
    limits: LIMITS,
  });
  // 總量還剩 8，這個 model 只剩 1
  assert.equal(verdict.remaining, 1);
});

test('沒有任何紀錄的人是從 0 開始', () => {
  const verdict = judgeCall({ key: 'x', limits: LIMITS });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.total, 0);
});

test('擋下來的兩種原因講不同的話', () => {
  // 混成一句的話，使用者不知道自己還有沒有路可以走（換模型還是等明天）
  const total = describeBlock({ reason: 'total', totalLimit: 10 });
  const key = describeBlock({ reason: 'key', limit: 3 }, { what: 'AI 修正' });
  assert.match(total, /所有模式一起算/);
  assert.match(key, /換一個模型/);
  assert.notEqual(total, key);
});

// ─── 計數真的存得住（store）──────────────────────────────────────────────

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-test-'));
  const store = createStore(dir);
  await store.init();
  return { store, dir };
}

test('放行才加一 —— 擋下來的那一次不算用掉', async () => {
  const { store } = await tempStore();
  const day = '2026-09-08';
  const limits = { total: 2, byKey: {} };
  const spend = () => store.spendUsage('u1', 'm', {
    day,
    judge: (usage) => judgeCall({ usage, key: 'm', limits }),
  });

  assert.equal((await spend()).allowed, true);
  assert.equal((await spend()).allowed, true);
  const third = await spend();
  assert.equal(third.allowed, false);
  // 擋下來之後計數還是 2，不是 3 —— 不然「明天才會回來」會變成「後天」
  assert.equal((await store.readUsage('u1', day)).total, 2);
});

test('每個人各自算，每一天各自算', async () => {
  const { store } = await tempStore();
  const limits = { total: 1, byKey: {} };
  const spend = (user, day) => store.spendUsage(user, 'm', {
    day,
    judge: (usage) => judgeCall({ usage, key: 'm', limits }),
  });

  assert.equal((await spend('u1', '2026-09-08')).allowed, true);
  assert.equal((await spend('u1', '2026-09-08')).allowed, false);
  // 另一個人不受影響
  assert.equal((await spend('u2', '2026-09-08')).allowed, true);
  // 隔天重新開始
  assert.equal((await spend('u1', '2026-09-09')).allowed, true);
});

test('同時進來的請求不會各自讀到同一個舊數字', async () => {
  // 「先 readUsage 再 recordUsage」的寫法在這裡會過頭 —— 兩趟中間會讓出去。
  // spendUsage 把判斷與加一放在同一個獨佔區段裡就沒有那個空隙
  const { store } = await tempStore();
  const limits = { total: 3, byKey: {} };
  const results = await Promise.all(
    Array.from({ length: 10 }, () => store.spendUsage('u1', 'm', {
      day: '2026-09-08',
      judge: (usage) => judgeCall({ usage, key: 'm', limits }),
    }))
  );
  assert.equal(results.filter((r) => r.allowed).length, 3);
  assert.equal((await store.readUsage('u1', '2026-09-08')).total, 3);
});

test('逐模型的計數分開記，總量是加起來的', async () => {
  const { store } = await tempStore();
  const day = '2026-09-08';
  const limits = { total: 100, byKey: {} };
  for (const key of ['azure', 'azure', 'gemini-3.6-flash']) {
    await store.spendUsage('u1', key, {
      day, judge: (usage) => judgeCall({ usage, key, limits }),
    });
  }
  const usage = await store.readUsage('u1', day);
  assert.equal(usage.total, 3);
  assert.deepEqual(usage.byKey, { azure: 2, 'gemini-3.6-flash': 1 });
});

test('只留最近幾天 —— 這份資料只有「今天」會被讀', async () => {
  const { store, dir } = await tempStore();
  const limits = { total: null, byKey: {} };
  for (let d = 1; d <= 10; d++) {
    const day = `2026-09-${String(d).padStart(2, '0')}`;
    await store.spendUsage('u1', 'm', {
      day, judge: (usage) => judgeCall({ usage, key: 'm', limits }),
    });
  }
  const file = JSON.parse(await fs.readFile(path.join(dir, 'usage.json'), 'utf8'));
  const days = Object.keys(file).sort();
  assert.equal(days.length, 7);
  assert.equal(days[days.length - 1], '2026-09-10');
});

test('沒有紀錄的人回 0，不是 undefined', async () => {
  const { store } = await tempStore();
  assert.deepEqual(await store.readUsage('nobody', '2026-09-08'), { total: 0, byKey: {} });
});
