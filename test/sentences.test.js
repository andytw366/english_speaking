// sentences.json 的資料檢查。不需要網路與金鑰。
//
// 為什麼值得測：這份資料是手寫的，而錯了不會炸 —— 只會安靜地讓功能失效。
// 例如 focus 打錯一個字，那句就永遠不會因為弱點被抽到，畫面上完全看不出來。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ISSUE_CODES } from '../server/gemini.js';
import { CATEGORY_LABEL, DIFFICULTY_LABEL } from '../public/labels.js';

const sentences = JSON.parse(readFileSync(new URL('../sentences.json', import.meta.url)));

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

test('句子沒有重複', () => {
  const texts = sentences.map((s) => s.text.trim().toLowerCase());
  assert.equal(new Set(texts).size, texts.length);
});
