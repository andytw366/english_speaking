// 每日成績表與四個能力面向（`public/lib/ability.js`、`storage.js` 的 `results`、
// `lib/day-summary.js`）。
//
// 這幾段算錯的症狀都是**靜悄悄的**：畫面照樣畫得出一張圖、一個分數，
// 只是那個數字不對。所以每一條規則都在這裡釘一次：
//
//   1. 計數器只會往上加（合併規則要的是這個性質，見 merge.test.js）
//   2. 樣本不夠時是 null，不是 0 —— 「沒練過」不等於「0 分」
//   3. 中翻英與對話的判定：模型看過的那一份優先
//   4. 鼓勵的那一句是從真的數字算出來的，不是罐頭

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  addResult, sumResults, resultDays, RESULT_FIELDS, RESULTS_DAY_LIMIT,
} from '../public/lib/storage.js';
import {
  computeAbility, topWeaknesses, recentDays, DIMENSIONS, MIN_SAMPLE, OK_SCORE, WINDOW_DAYS,
} from '../public/lib/ability.js';
import { radarCaption } from '../public/lib/radar-chart.js';
import { summariseDay, encourage } from '../public/lib/day-summary.js';

// ─── 每日成績表（storage.js 的 results）──────────────────────────────────

test('成績只加自己那一格，別台裝置的一個都不碰', () => {
  const before = { vocabulary: { '2026-09-18': { 'dev-b': { n: 4, ok: 4 } } } };
  const after = addResult(before, 'vocabulary', '2026-09-18', { n: 1, ok: 1, fresh: 1 },
    { slot: 'dev-a' });

  assert.deepEqual(after.vocabulary['2026-09-18'], {
    'dev-b': { n: 4, ok: 4 },
    'dev-a': { n: 1, ok: 1, fresh: 1 },
  });
  // 純函式：原本那份不能被改到
  assert.deepEqual(before.vocabulary['2026-09-18'], { 'dev-b': { n: 4, ok: 4 } });
});

test('答錯也要記 —— ok 加 0，但 n 一定要加上去', () => {
  const after = addResult({}, 'listening', '2026-09-18', { n: 1, q: 3, ok: 0 }, { slot: 'a' });
  assert.deepEqual(after.listening['2026-09-18'].a, { n: 1, q: 3, ok: 0 });

  // 分母漏掉的話正確率會是 100%，而畫面上完全看不出原因
  assert.equal(sumResults(after, 'listening', ['2026-09-18']).q, 3);
});

test('只認得白名單裡的計數器與模式', () => {
  const junk = addResult({}, 'vocabulary', '2026-09-18', { n: 1, evil: 99 }, { slot: 'a' });
  assert.deepEqual(Object.keys(junk.vocabulary['2026-09-18'].a), ['n']);

  // 不存在的模式整個退掉，不要在表上長出一個沒有人讀得懂的鍵
  assert.deepEqual(addResult({}, 'nope', '2026-09-18', { n: 1 }), {});
  // 沒有一個認得的欄位 = 什麼都沒發生
  assert.deepEqual(addResult({}, 'vocabulary', '2026-09-18', { evil: 1 }), {});
});

test('計數器只會往上加（合併規則靠的就是這個性質）', () => {
  let table = {};
  for (let i = 0; i < 5; i++) {
    table = addResult(table, 'shadowing', '2026-09-18', { n: 1, sum: 70 }, { slot: 'a' });
  }
  assert.deepEqual(table.shadowing['2026-09-18'].a, { n: 5, sum: 350 });
});

test('每個模式只留最近幾天', () => {
  let table = {};
  for (let d = 1; d <= RESULTS_DAY_LIMIT + 5; d++) {
    const day = `2026-${String(Math.ceil(d / 28)).padStart(2, '0')}-${String(((d - 1) % 28) + 1).padStart(2, '0')}`;
    table = addResult(table, 'translation', day, { n: 1, ok: 1 }, { slot: 'a' });
  }
  assert.ok(Object.keys(table.translation).length <= RESULTS_DAY_LIMIT);
});

test('壞掉的值不會把總和弄成 NaN（localStorage 是使用者改得到的）', () => {
  const table = {
    listening: { '2026-09-18': { a: { n: 'x', q: -3, ok: null }, b: { n: 2, q: 4, ok: 3 } } },
  };
  assert.deepEqual(sumResults(table, 'listening', ['2026-09-18']), { n: 2, q: 4, ok: 3 });
});

test('resultDays 由新到舊', () => {
  const table = { shadowing: { '2026-09-16': {}, '2026-09-18': {}, '2026-09-17': {} } };
  assert.deepEqual(resultDays(table, 'shadowing'), ['2026-09-18', '2026-09-17', '2026-09-16']);
});

// ─── 四個面向 ────────────────────────────────────────────────────────────

const DAY = '2026-09-18';
const NOW = Date.parse('2026-09-18T12:00:00Z');

function srsOf(boxes) {
  return Object.fromEntries(boxes.map((box, i) => [`ecdict:${i + 1}`, { box, due: 0 }]));
}

function dimOf(dims, id) {
  return dims.find((d) => d.id === id);
}

test('四個面向，不是五個模式 —— 中翻英與對話合成「表達」', () => {
  assert.deepEqual(DIMENSIONS.map((d) => d.id), ['vocab', 'listen', 'express', 'pronounce']);
  assert.deepEqual(dimOf(DIMENSIONS, 'express').modes, ['translation', 'dialogue']);
});

test('樣本不夠時分數是 null，不是 0', () => {
  // 0 分的意思是「練了，很差」；沒練過的模式畫成 0 等於對沒碰過的人說他是 0 分
  const dims = computeAbility({ results: {}, srsState: {}, now: NOW });
  for (const d of dims) {
    assert.equal(d.score, null, `${d.id} 沒有資料時應該是 null`);
    assert.match(d.note, /再練 \d+ 個?[字題句]就算得出來/, `${d.id} 要講還差多少`);
  }
});

test('剛好踩到門檻就算得出來', () => {
  const results = { listening: { [DAY]: { a: { n: 3, q: MIN_SAMPLE.listen, ok: 5 } } } };
  const dims = computeAbility({ results, srsState: {}, now: NOW });
  assert.equal(dimOf(dims, 'listen').score, 50);

  const under = { listening: { [DAY]: { a: { n: 3, q: MIN_SAMPLE.listen - 1, ok: 5 } } } };
  assert.equal(dimOf(computeAbility({ results: under, srsState: {}, now: NOW }), 'listen').score, null);
});

test('聽力的正確率照「題」算，不是照「組」', () => {
  // 今天的份算「組」（一組 2～6 題），但一組答對 1/6 與 1/2 不是同一回事
  const results = { listening: { [DAY]: { a: { n: 2, q: 12, ok: 3 } } } };
  const dim = dimOf(computeAbility({ results, srsState: {}, now: NOW }), 'listen');
  assert.equal(dim.score, 25);
  assert.equal(dim.sample, 12);
});

test('字彙是「練過的字現在平均在第幾盒」，全部第 1 盒是 0、全部第 6 盒是 100', () => {
  const all1 = computeAbility({ results: {}, srsState: srsOf(Array(10).fill(1)), now: NOW });
  assert.equal(dimOf(all1, 'vocab').score, 0);

  const all6 = computeAbility({ results: {}, srsState: srsOf(Array(10).fill(6)), now: NOW });
  assert.equal(dimOf(all6, 'vocab').score, 100);

  // 量（幾個字、熟練幾個）不在分數裡，在旁邊那行字裡 —— 理由見 ability.js 開頭
  assert.match(dimOf(all6, 'vocab').detail, /練過 10 個字・已熟練 10 個/);
});

test('字彙不需要任何字庫檔 —— 盒號在 srs 裡就有', () => {
  // 首頁的老規矩：為了一個數字把 3 MB 的字庫抓下來太蠢。
  // 這條測試擋的是「有人為了算得更準而去 import 字庫」
  const src = fs.readFileSync(new URL('../public/lib/ability.js', import.meta.url), 'utf8');
  assert.equal(/content\/vocabulary|tier-map|\/api\/vocabulary/.test(src), false,
    'ability.js 不可以碰字庫檔');
});

test('表達：模型看過的那一份優先，並且說清楚是誰判的', () => {
  const results = {
    translation: { [DAY]: { a: { n: 20, ok: 20, aiN: 12, aiOk: 6 } } },
  };
  const dim = dimOf(computeAbility({ results, srsState: {}, now: NOW }), 'express');
  // 本地比對說 100%，模型說 50% —— 以模型為準
  assert.equal(dim.score, 50);
  assert.match(dim.note, /AI 判過的 12 題/);
});

test('表達：模型判過的量不夠就退回關鍵字比對，而且要講明白', () => {
  const results = { translation: { [DAY]: { a: { n: 20, ok: 15, aiN: 2, aiOk: 0 } } } };
  const dim = dimOf(computeAbility({ results, srsState: {}, now: NOW }), 'express');
  assert.equal(dim.score, 75);
  assert.match(dim.note, /關鍵字比對/);
});

test('表達把中翻英與對話加在一起', () => {
  const results = {
    translation: { [DAY]: { a: { n: 6, ok: 6 } } },
    dialogue: { [DAY]: { a: { n: 6, ok: 0 } } },
  };
  assert.equal(dimOf(computeAbility({ results, srsState: {}, now: NOW }), 'express').score, 50);
});

test('唸得準是平均分（sum / n），不是存起來的平均', () => {
  const results = { shadowing: { [DAY]: { a: { n: 4, sum: 290 } } } };
  assert.equal(dimOf(computeAbility({ results, srsState: {}, now: NOW }), 'pronounce').score, 73);
});

test('分數夾在 0～100（壞資料不該畫出圖外面的點）', () => {
  const results = { shadowing: { [DAY]: { a: { n: 1, sum: 9999 } } } };
  const dim = dimOf(computeAbility({ results, srsState: {}, now: NOW }), 'pronounce');
  assert.ok(dim.score <= 100 && dim.score >= 0);
});

// ─── 最近幾天 ────────────────────────────────────────────────────────────

test('看的是最近幾個「有練的日子」，不是最近幾個日曆天', () => {
  // 出差一週沒打開，回來時能力圖不該變成一片空白 —— 那幾天沒有新資訊，
  // 不是舊資訊失效了
  const results = { shadowing: { '2026-01-01': {}, '2026-05-05': {}, '2026-09-18': {} } };
  assert.deepEqual(recentDays(results, ['shadowing']), ['2026-09-18', '2026-05-05', '2026-01-01']);
});

test('最多只看 WINDOW_DAYS 天', () => {
  const days = {};
  for (let d = 1; d <= WINDOW_DAYS + 6; d++) days[`2026-09-${String(d).padStart(2, '0')}`] = {};
  assert.equal(recentDays({ listening: days }, ['listening']).length, WINDOW_DAYS);
});

test('表達的「最近」跨兩個模式取聯集', () => {
  const results = {
    translation: { '2026-09-18': {} },
    dialogue: { '2026-09-17': {} },
  };
  assert.deepEqual(recentDays(results, ['translation', 'dialogue']),
    ['2026-09-18', '2026-09-17']);
});

// ─── 現在最該練什麼 ──────────────────────────────────────────────────────

const label = (c) => ({ th: 'th 音', r_l: 'r / l' })[c] ?? c;

test('由低到高排，最低的那一條要說出它最低', () => {
  const dims = [
    { id: 'vocab', label: '字彙', icon: '🗂️', modes: ['vocabulary'], score: 70, detail: 'a' },
    { id: 'listen', label: '聽得懂', icon: '🎧', modes: ['listening'], score: 40, detail: 'b' },
  ];
  const out = topWeaknesses(dims, { issueLabel: label });
  assert.equal(out[0].id, 'listen');
  assert.match(out[0].text, /四個面向裡最低/);
  assert.equal(out[1].id, 'vocab');
  assert.equal(out[1].text.includes('最低'), false);
});

test('夠好的面向不會被排進來', () => {
  const dims = [
    { id: 'vocab', label: '字彙', icon: '🗂️', modes: ['vocabulary'], score: OK_SCORE, detail: 'a' },
  ];
  assert.deepEqual(topWeaknesses(dims, { issueLabel: label }), []);
});

test('按鈕上寫的是分頁的名字，不是面向的名字', () => {
  // 面向是「聽得懂」，但畫面下面那一列上寫的是「聽力」
  const dims = [{ id: 'listen', label: '聽得懂', icon: '🎧', modes: ['listening'], score: 40, detail: 'b' }];
  assert.equal(topWeaknesses(dims, { issueLabel: label })[0].cta, '去練聽力');
});

test('問題音併進「唸得準」那一條，不另外開一條', () => {
  const dims = [
    { id: 'pronounce', label: '唸得準', icon: '🗣️', modes: ['shadowing'], score: 60, detail: 'x' },
  ];
  const out = topWeaknesses(dims, { weak: new Map([['th', 9]]), issueLabel: label });
  assert.equal(out.length, 1, '不該有兩條都在講發音');
  assert.match(out[0].text, /th 音（9 次）/);
});

test('唸得準本身夠好，但同一個音一直被點名 —— 那仍然是一條', () => {
  const dims = [
    { id: 'pronounce', label: '唸得準', icon: '🗣️', modes: ['shadowing'], score: 92, detail: 'x' },
  ];
  const out = topWeaknesses(dims, { weak: new Map([['th', 9]]), issueLabel: label });
  assert.equal(out.length, 1);
  assert.equal(out[0].mode, 'shadowing');
  assert.match(out[0].text, /9 次/);
});

test('一兩次不算「你的問題」', () => {
  const dims = [
    { id: 'pronounce', label: '唸得準', icon: '🗣️', modes: ['shadowing'], score: 92, detail: 'x' },
  ];
  assert.deepEqual(topWeaknesses(dims, { weak: new Map([['th', 2]]), issueLabel: label }), []);
});

test('沒有資料的面向排最後（它不是「問題」，是「還不知道」）', () => {
  const dims = [
    { id: 'vocab', label: '字彙', icon: '🗂️', modes: ['vocabulary'], score: null, note: '再練 10 個字就算得出來' },
    { id: 'listen', label: '聽得懂', icon: '🎧', modes: ['listening'], score: 40, detail: 'b' },
  ];
  const out = topWeaknesses(dims, { issueLabel: label });
  assert.equal(out[0].id, 'listen');
  assert.match(out[1].text, /還沒有足夠的資料/);
});

// ─── 雷達圖的文字說明 ────────────────────────────────────────────────────

test('圖對讀螢幕的人沒有意義，走勢要用文字再講一次', () => {
  const caption = radarCaption([
    { label: '字彙', score: 46 }, { label: '聽得懂', score: 58 },
    { label: '表達', score: null }, { label: '唸得準', score: 73 },
  ]);
  assert.match(caption, /字彙 46 分/);
  assert.match(caption, /表達還沒有資料/);
  assert.match(caption, /最低的是字彙/);
});

test('一個面向都還沒有資料時不要硬講「最低的是」', () => {
  assert.match(radarCaption([{ label: '字彙', score: null }]), /都還沒有足夠的資料/);
});

// ─── 今天的總結 ──────────────────────────────────────────────────────────

const state = (goal, done, streak) => ({ goal, done, streak, remaining: Math.max(0, goal - done) });

test('基準是最近幾個有練的日子，不含今天', () => {
  const results = {
    translation: {
      [DAY]: { a: { n: 10, ok: 9 } },
      '2026-09-17': { a: { n: 10, ok: 5 } },
      '2026-09-16': { a: { n: 10, ok: 5 } },
    },
  };
  const s = summariseDay({ mode: 'translation', results, state: state(10, 10, 3), now: NOW });
  assert.equal(s.rate, 90);
  assert.equal(s.pastRate, 50);
  assert.equal(s.pastDays, 2);
});

test('鼓勵是從真的數字算出來的（進步 > 超出目標 > 連續天數）', () => {
  const results = {
    translation: {
      [DAY]: { a: { n: 10, ok: 9 } },
      '2026-09-17': { a: { n: 10, ok: 5 } },
      '2026-09-16': { a: { n: 10, ok: 5 } },
    },
  };
  const s = summariseDay({ mode: 'translation', results, state: state(10, 10, 3), now: NOW });
  assert.match(encourage(s, '題'), /90%.*50%.*40 個百分點/);
});

test('沒有進步可以講就講超出目標，再沒有就講連續天數', () => {
  const over = summariseDay({
    mode: 'translation', results: { translation: { [DAY]: { a: { n: 14, ok: 7 } } } },
    state: state(10, 14, 5), now: NOW,
  });
  assert.match(encourage(over, '題'), /多做了 4 題/);

  const plain = summariseDay({
    mode: 'translation', results: { translation: { [DAY]: { a: { n: 10, ok: 5 } } } },
    state: state(10, 10, 5), now: NOW,
  });
  assert.match(encourage(plain, '題'), /連續第 5 天/);
});

test('鼓勵一句罰的話都沒有 —— 不寫「連續天數要斷了」那種句子', () => {
  // 這條規矩從 today-card.js 的 todayNote() 就開始了。用罰的去推人回來，
  // 短期有效，長期只會讓人不想打開
  const cases = [
    summariseDay({ mode: 'translation', results: {}, state: state(10, 10, 1), now: NOW }),
    summariseDay({ mode: 'translation', results: {}, state: state(10, 12, 0), now: NOW }),
    summariseDay({ mode: 'shadowing', results: {}, state: state(5, 5, 9), now: NOW }),
  ];
  for (const s of cases) {
    const line = encourage(s, '題');
    assert.equal(/斷|白費|可惜|沒有練|歸零|不要/.test(line), false, `不該有罰的語氣：${line}`);
    assert.ok(line.length > 0);
  }
});

test('跟讀的總結講平均分，不講正確率（它沒有對錯）', () => {
  const results = { shadowing: { [DAY]: { a: { n: 4, sum: 300 } } } };
  const s = summariseDay({ mode: 'shadowing', results, state: state(4, 4, 1), now: NOW });
  assert.equal(s.rate, null);
  assert.equal(s.average, 75);
});

test('今天被點名最多的音只算今天的紀錄', () => {
  const history = [
    { at: '2026-09-18T10:00:00Z', problemWords: [{ word: 'the', issue: 'th' }] },
    { at: '2026-09-18T11:00:00Z', problemWords: [{ word: 'think', issue: 'th' }] },
    { at: '2026-09-01T11:00:00Z', problemWords: [{ word: 'red', issue: 'r_l' }] },
  ];
  const s = summariseDay({ mode: 'shadowing', results: {}, state: state(5, 5, 1), history, now: NOW });
  assert.deepEqual(s.issues, [{ issue: 'th', count: 2 }]);
});

test('每個模式的計數器白名單都對得上它記的東西', () => {
  // 改一個模式記什麼的時候，這條會提醒「ability.js 那邊也要跟著改」
  assert.deepEqual(RESULT_FIELDS.vocabulary, ['n', 'ok', 'fresh']);
  assert.deepEqual(RESULT_FIELDS.listening, ['n', 'q', 'ok']);
  assert.deepEqual(RESULT_FIELDS.translation, ['n', 'ok', 'aiN', 'aiOk']);
  assert.deepEqual(RESULT_FIELDS.dialogue, ['n', 'ok', 'aiN', 'aiOk']);
  assert.deepEqual(RESULT_FIELDS.shadowing, ['n', 'sum']);
});
