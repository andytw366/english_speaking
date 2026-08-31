// 後端對 Gemini 回應的整理與防禦。不需要網路與金鑰
//（import 不會建立 client，getClient() 是第一次呼叫時才做的）。
//
// 這裡測的是 normalizeProblemWords —— structured output 有 schema，
// 但 schema 是「請模型照這個格式」不是「保證一定是這個格式」，
// 而這些欄位會直接被畫到畫面上。

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeProblemWords, ISSUE_CODES } from '../server/gemini.js';

test('正常的物件會原樣留下，前後空白去掉', () => {
  const [item] = normalizeProblemWords([
    { word: '  thoroughly ', heard: ' sorrowly ', issue: 'th', tip_zh: ' 舌尖伸到門牙之間 ' },
  ]);

  assert.deepEqual(item, {
    word: 'thoroughly',
    heard: 'sorrowly',
    issue: 'th',
    tip_zh: '舌尖伸到門牙之間',
  });
});

test('舊格式（純字串）也吃得下', () => {
  // localStorage 裡的舊紀錄不會因為我們改了 schema 就跟著變
  assert.deepEqual(normalizeProblemWords(['scheduled']), [
    { word: 'scheduled', heard: '', issue: 'other', tip_zh: '' },
  ]);
});

test('只有 word 也留著，不會因為缺欄位就整個字被丟掉', () => {
  // word 決定句子裡哪個字要標紅；heard／tip_zh 只是補充。
  // 因為少一欄就丟掉整個字，使用者反而看不到「這個字唸錯了」這件最重要的事。
  assert.deepEqual(normalizeProblemWords([{ word: 'the' }]), [
    { word: 'the', heard: '', issue: 'other', tip_zh: '' },
  ]);
});

test('沒有 word 的項目會被丟掉', () => {
  assert.deepEqual(normalizeProblemWords([{ heard: 'x', tip_zh: 'y' }, { word: '   ' }]), []);
});

test('沒見過的 issue 代碼會被歸成 other', () => {
  // 代碼會被拿去查中文標籤，漏一個沒對應的就會讓代碼原文出現在畫面上
  const [item] = normalizeProblemWords([{ word: 'w', issue: 'made_up_code' }]);
  assert.equal(item.issue, 'other');
  assert.ok(ISSUE_CODES.includes(item.issue));
});

test('每一個列舉值都通得過驗證（清單與檢查沒有走鐘）', () => {
  for (const code of ISSUE_CODES) {
    const [item] = normalizeProblemWords([{ word: 'w', issue: code }]);
    assert.equal(item.issue, code);
  }
});

test('最多留 3 個', () => {
  // 每一項現在都有一段說明，列太多等於沒有重點，也會拉高輸出 token
  const many = Array.from({ length: 9 }, (_, i) => ({ word: `w${i}` }));
  assert.equal(normalizeProblemWords(many).length, 3);
});

test('壞掉的輸入不會丟例外', () => {
  assert.deepEqual(normalizeProblemWords(undefined), []);
  assert.deepEqual(normalizeProblemWords(null), []);
  assert.deepEqual(normalizeProblemWords('thoroughly'), []); // 字串不是陣列
  assert.deepEqual(normalizeProblemWords([null, 42, [], true]), []);
});
