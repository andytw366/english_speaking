// 自動標音的回歸測試。不需要網路與金鑰（CMU 字典是 devDependency，跑 npm ci 就有）。
//
// 這支測試釘的是句庫能不能自動長大：`focus` 標錯不會讓任何東西壞掉，
// 只會讓「這句在練 th 音」變成一句謊話，而那種錯誤從畫面上看不出來。

import test from 'node:test';
import assert from 'node:assert/strict';

import { focusTags, issueScores, pronounce, syllables, tokenize } from '../scripts/phonetics.js';

test('tokenize：保留撇號，don\'t 才查得到發音', () => {
  assert.deepEqual(tokenize("Don't you know?"), ["don't", 'you', 'know']);
  assert.deepEqual(tokenize('Hello, world!'), ['hello', 'world']);
});

test('pronounce：查得到的字回音素，查不到就整句回 null', () => {
  const said = pronounce('I think so.');
  assert.equal(said.length, 3);
  assert.deepEqual(said[1], { word: 'think', phones: ['TH', 'IH', 'NG', 'K'] });

  // 一個字查不到就不能用：那個字的音沒把握，標出來的 focus 也就沒把握
  assert.equal(pronounce('I zzzqx so.'), null);
  assert.equal(pronounce(''), null);
});

test('syllables：母音的數量就是音節數', () => {
  assert.equal(syllables(pronounce('cat')[0].phones), 1);
  assert.equal(syllables(pronounce('water')[0].phones), 2);
  assert.equal(syllables(pronounce('beautiful')[0].phones), 3);
});

test('focusTags：th 很密的句子一定標到 th', () => {
  assert.ok(focusTags('The thirty-three thieves thought about the throne.').includes('th'));
});

test('focusTags：只有 w 沒有 v 的句子不可以標成 v_w', () => {
  // 這正是人工標的時候犯的錯 —— v／w 是「分辨」，只有一邊根本練不到，
  // 標了之後畫面上會出現「這句在練 v / w」，而那句話是假的
  const tags = focusTags('Would you wait for me at the window?');
  assert.ok(!tags.includes('v_w'), `不該有 v_w：${tags}`);

  // 兩個音都在才算
  assert.ok(focusTags('Very few of the volunteers were available.').includes('v_w'));
});

test('focusTags：只有 r 沒有 l 的句子不可以標成 r_l', () => {
  assert.ok(!focusTags('Are you sure they were correct?').includes('r_l'));
});

test('focusTags：最多兩個標籤', () => {
  for (const text of [
    'I would like to schedule a meeting with the whole team tomorrow.',
    'The children thought the theater was closed on Thursdays.',
    'We reserved a table for three at seven thirty.',
  ]) {
    assert.ok(focusTags(text).length <= 2, text);
  }
});

test('focusTags：不會被 final_consonant 這種「每句都有」的音佔滿', () => {
  // 沒有做基準線正規化的版本，標籤幾乎每句都是 final_consonant + linking，
  // 因為那是英文的結構特性，不是「這句特別適合練它」
  const samples = [
    'I think that this is the third one.',
    'Very few of the volunteers were available.',
    'She was singing along with the recording.',
    'We asked them to send the signed documents back.',
  ];
  const tags = samples.flatMap((s) => focusTags(s));
  const structural = tags.filter((t) => t === 'final_consonant' || t === 'linking').length;
  assert.ok(structural < tags.length, `不該全部都是結構性的音：${tags}`);
});

test('focusTags：查不到發音時回空陣列，不會丟例外', () => {
  assert.deepEqual(focusTags('I zzzqx so.'), []);
  assert.deepEqual(focusTags(''), []);
  assert.deepEqual(focusTags(null), []);
});

test('focusTags：同一句每次都給一樣的結果', () => {
  // 分數相同時要有穩定的排序，不然每次匯入都會產生無意義的 diff
  const text = 'Could you tell me where the nearest station is?';
  const first = focusTags(text);
  for (let i = 0; i < 5; i += 1) assert.deepEqual(focusTags(text), first);
});

test('issueScores：分數是密度，長句不會單純因為字多就每個音都高分', () => {
  const short = issueScores('I think so.');
  const long = issueScores('I think that we should probably talk about it later today.');
  assert.ok(short.get('th') > long.get('th'), `${short.get('th')} 應該大於 ${long.get('th')}`);
});
