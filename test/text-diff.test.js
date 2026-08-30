// 目標句與 transcript 逐字比對的回歸測試。不需要瀏覽器、網路與金鑰。
//
// 為什麼值得測：比對壞掉的症狀是「整句都標紅」或「明明唸錯卻沒標」，
// 兩種都很容易被誤會成模型的問題，而不是前端的比對邏輯。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeWord,
  matchedTargetIndices,
  diffWords,
  problemWordText,
} from '../public/text-diff.js';

const TARGET = 'Could you tell me where the nearest subway station is?';

/** 方便看結果：回傳被標紅的字。 */
const missed = (transcript, problems = []) =>
  diffWords(TARGET, transcript, problems)
    .filter((w) => w.miss)
    .map((w) => w.word);

test('normalizeWord：去掉大小寫與標點，但保留撇號', () => {
  assert.equal(normalizeWord('Could'), 'could');
  assert.equal(normalizeWord('station?'), 'station');
  assert.equal(normalizeWord("don't"), "don't");
  assert.equal(normalizeWord('“Hello,”'), 'hello');
});

test('完全唸對時沒有任何字被標紅', () => {
  assert.deepEqual(missed(TARGET), []);
});

test('標點與大小寫不同不算唸錯', () => {
  assert.deepEqual(missed('could you tell me where the nearest subway station is'), []);
});

test('漏掉中間一個字時，只有那個字被標紅（不會整句歪掉）', () => {
  // 逐字對位的實作會讓後面每個字都偏移一格 → 整句標紅，那種畫面沒有參考價值
  assert.deepEqual(missed('Could you tell me where the subway station is?'), ['nearest']);
});

test('多唸了一個字時，目標句本身不會被標紅', () => {
  assert.deepEqual(missed('Could you please tell me where the nearest subway station is?'), []);
});

test('唸錯的字會被標紅，其他不受影響', () => {
  assert.deepEqual(missed('Could you tell me where the nearest sub way station is?'), ['subway']);
});

test('problem_words 點名的字即使有聽到也標紅，理由是「發音待加強」', () => {
  const words = diffWords(TARGET, TARGET, ['nearest']);
  const nearest = words.find((w) => w.word === 'nearest');
  assert.equal(nearest.miss, true);
  assert.equal(nearest.reason, 'problem');
});

test('沒聽到的字理由是 unheard，不會被寫成「發音待加強」', () => {
  // 這兩個理由給使用者的訊息不同：一個是沒唸到，一個是唸了但不準
  const words = diffWords(TARGET, 'Could you tell me', []);
  assert.equal(words.find((w) => w.word === 'subway').reason, 'unheard');
});

test('同一個字同時沒聽到又被點名時，以「沒聽到」為準', () => {
  const words = diffWords(TARGET, 'Could you tell me', ['subway']);
  assert.equal(words.find((w) => w.word === 'subway').reason, 'unheard');
});

test('transcript 是空的時候，整句都算沒聽到', () => {
  const words = diffWords(TARGET, '', []);
  assert.equal(words.length, TARGET.split(/\s+/).length);
  assert.ok(words.every((w) => w.miss && w.reason === 'unheard'));
});

test('transcript 是 null／undefined 不會炸', () => {
  // 後端理論上不會回 null，但講評是外部資料，前端不能假設欄位一定在
  const wordCount = TARGET.split(/\s+/).length;
  assert.equal(diffWords(TARGET, null).length, wordCount);
  assert.equal(diffWords(TARGET, undefined, undefined).length, wordCount);
  assert.deepEqual(diffWords(null, null), []);
});

test('matchedTargetIndices 回的是目標句的 index', () => {
  const matched = matchedTargetIndices(['a', 'b', 'c'], ['a', 'c']);
  assert.deepEqual([...matched].sort(), [0, 2]);
});

test('重複的字不會互相對錯位', () => {
  // "the ... the"：只唸了第一個 the 時，第二個要算沒唸到
  const words = diffWords('the cat and the dog', 'the cat and dog');
  assert.deepEqual(
    words.map((w) => w.miss),
    [false, false, false, true, false]
  );
});

// ─── problem_words 的兩種格式 ───────────────────────────────────────────
// 階段 7 把它從字串陣列換成物件；使用者 localStorage 裡的舊紀錄還是字串。

test('problemWordText：字串與物件都取得到單字', () => {
  assert.equal(problemWordText('nearest'), 'nearest');
  assert.equal(problemWordText({ word: 'nearest', issue: 'th' }), 'nearest');
  assert.equal(problemWordText(null), '');
  assert.equal(problemWordText({}), '');
  assert.equal(problemWordText(42), '');
});

test('新格式（物件）的 problem_words 一樣標得到紅字', () => {
  const words = diffWords(TARGET, TARGET, [{ word: 'nearest', issue: 'th', tip_zh: '…' }]);
  assert.equal(words.find((w) => w.word === 'nearest').reason, 'problem');
});

test('新舊格式混在一起也不會壞', () => {
  const words = diffWords(TARGET, TARGET, ['subway', { word: 'nearest' }, null]);
  assert.deepEqual(
    words.filter((w) => w.miss).map((w) => w.word),
    ['nearest', 'subway']
  );
});

test('problem_words 不是陣列時不會丟例外', () => {
  assert.equal(diffWords(TARGET, TARGET, 'nearest').filter((w) => w.miss).length, 0);
  assert.equal(diffWords(TARGET, TARGET, null).filter((w) => w.miss).length, 0);
});
