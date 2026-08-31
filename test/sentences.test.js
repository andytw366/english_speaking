// content/sentences.json 的資料檢查。不需要網路與金鑰。
//
// 為什麼值得測：這份資料是手寫的，而錯了不會炸 —— 只會安靜地讓功能失效。
// 例如 focus 打錯一個字，那句就永遠不會因為弱點被抽到，畫面上完全看不出來。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ISSUE_CODES } from '../server/gemini.js';
import { CATEGORY_LABEL, DIFFICULTY_LABEL } from '../public/labels.js';

const sentences = JSON.parse(readFileSync(new URL('../content/sentences.json', import.meta.url)));

/** 某個音至少要有這麼多句可以抽。太少的話「多給你這個音」會變成「一直給你同樣那幾句」。 */
const MIN_PER_ISSUE = 5;

test('每一句都有必要欄位，型別也對', () => {
  for (const s of sentences) {
    assert.equal(typeof s.id, 'number', `id 有問題：${JSON.stringify(s)}`);
    assert.ok(typeof s.text === 'string' && s.text.trim(), `text 是空的：${s.id}`);
    assert.ok(Array.isArray(s.focus), `focus 不是陣列：${s.id}`);
  }
});

test('id 沒有重複', () => {
  // 重複的 id 會讓練習紀錄對到錯的句子，而且「重練這句」會跳到另一句
  const ids = sentences.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('category 與 difficulty 都有對應的中文標籤', () => {
  // 沒有標籤時前端會退回顯示原始英文代碼，那是資料錯了的徵兆而不是設計
  for (const s of sentences) {
    assert.ok(CATEGORY_LABEL[s.category], `沒有中文標籤的情境：${s.category}`);
    assert.ok(DIFFICULTY_LABEL[s.difficulty], `沒有中文標籤的難度：${s.difficulty}`);
  }
});

test('focus 裡的每個代碼都在 ISSUE_CODES 裡', () => {
  // 打錯一個字的後果是那句永遠不會因為弱點被抽到，而畫面上完全看不出來
  for (const s of sentences) {
    for (const tag of s.focus) {
      assert.ok(ISSUE_CODES.includes(tag), `未知的 focus 代碼「${tag}」在句子 ${s.id}`);
    }
  }
});

test('focus 不會是空的，也不會重複', () => {
  for (const s of sentences) {
    assert.ok(s.focus.length > 0, `句子 ${s.id} 沒有標 focus`);
    assert.equal(new Set(s.focus).size, s.focus.length, `句子 ${s.id} 的 focus 有重複`);
  }
});

test(`每個發音問題類型都有至少 ${MIN_PER_ISSUE} 句可以抽`, () => {
  const counts = new Map(ISSUE_CODES.map((code) => [code, 0]));
  for (const s of sentences) {
    for (const tag of s.focus) counts.set(tag, counts.get(tag) + 1);
  }

  // other 是「以上都不是」的兜底類型，不會拿來標句子
  for (const [code, count] of counts) {
    if (code === 'other') continue;
    assert.ok(count >= MIN_PER_ISSUE, `「${code}」只有 ${count} 句，至少要 ${MIN_PER_ISSUE} 句`);
  }
});

test('每個情境與難度的組合都有句子（篩選不會選出空池子）', () => {
  const categories = [...new Set(sentences.map((s) => s.category))];
  const difficulties = [...new Set(sentences.map((s) => s.difficulty))];

  for (const category of categories) {
    for (const difficulty of difficulties) {
      const pool = sentences.filter((s) => s.category === category && s.difficulty === difficulty);
      assert.ok(pool.length > 0, `${category} + ${difficulty} 沒有任何句子`);
    }
  }
});

test('中文意思：有的話不能是空字串，而且不能有簡體字', () => {
  // 匯入的句子帶中文（Tatoeba 的翻譯，用 OpenCC 轉成台灣正體），
  // 早期手寫的沒有。有欄位卻是空字串會在畫面上留一行空白。
  const SIMPLIFIED = /[们这来对说过时会个国还没热爱开关门问题华语电脑机业务讲练习没错觉见图书报纸]/;
  for (const s of sentences) {
    if (!('zh' in s)) continue;
    assert.ok(typeof s.zh === 'string' && s.zh.trim(), `zh 是空的：${s.id}`);
    assert.ok(!SIMPLIFIED.test(s.zh), `zh 有簡體字：${s.id}「${s.zh}」`);
  }
});

test('中文意思沒有踩到 OpenCC 的簡繁一對多陷阱', () => {
  // 簡體「发」對應正體的「發」與「髮」，靠詞組判斷；詞組表沒收的組合會轉錯，
  // 而錯字在畫面上看起來就只是個錯字，不會有任何錯誤訊息
  // 注意「沒幹」是對的（干 當動詞要轉成 幹），不要放進來
  const MISCONVERTED = /(髮明|髮現|髮生|髮展|髮出|頭發|裡程|幹凈|幹燥|才幹活)/;
  for (const s of sentences) {
    if (!s.zh) continue;
    assert.ok(!MISCONVERTED.test(s.zh), `簡繁轉換有問題：${s.id}「${s.zh}」`);
  }
});

test('句子裡不出現阿拉伯數字', () => {
  // 目標句要拿去跟 AI 聽到的內容逐字比對，而 "300,000" 唸出來是什麼
  // 取決於使用者怎麼讀 —— 一定對不上。要練數字就把它寫成英文。
  for (const s of sentences) {
    assert.ok(!/[0-9]/.test(s.text), `句子裡有數字：${s.id}「${s.text}」`);
  }
});

test('每一句都以句號、問號或驚嘆號結尾', () => {
  // 沒有結尾標點多半代表這句是從一段話裡切出來的半句
  for (const s of sentences) {
    assert.match(s.text, /[.?!]$/, `結尾怪怪的：${s.id}「${s.text}」`);
  }
});

test('句子沒有重複', () => {
  const texts = sentences.map((s) => s.text.trim().toLowerCase());
  assert.equal(new Set(texts).size, texts.length);
});
