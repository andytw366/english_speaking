// 中文講評的開關與本地摘要。不需要網路與金鑰。
//
// 這兩段之所以在 server/narration.js 而不是 server/index.js：index.js 一 import
// 就會 app.listen()，測不到。抽出來之後這裡才釘得住兩件事 ——
// 「什麼樣的值算關掉」與「講評缺席時使用者看到的說明對不對」。

import test from 'node:test';
import assert from 'node:assert/strict';

import { localSummary, wantsNarration } from '../server/narration.js';

test('沒送 narrate 欄位就是要講評（舊前端的行為不變）', () => {
  assert.equal(wantsNarration(undefined), true);
  assert.equal(wantsNarration(null), true);
  assert.equal(wantsNarration(''), true);
  assert.equal(wantsNarration('   '), true);
});

test('明確關掉的幾種寫法都算關掉', () => {
  // multipart 的欄位一律是字串，所以這裡收的是字串而不是 boolean
  for (const v of ['off', 'OFF', ' off ', 'false', '0', 'no']) {
    assert.equal(wantsNarration(v), false, `「${v}」應該算關掉`);
  }
});

test('其他值一律當成要講評 —— 寧可多等幾秒，也不要安靜地少一段回饋', () => {
  for (const v of ['on', 'true', '1', 'yes', 'maybe']) {
    assert.equal(wantsNarration(v), true, `「${v}」應該算要講評`);
  }
});

const ASSESSMENT = {
  referenceText: 'I think so.',
  recognizedText: 'I sink so.',
  scores: { pronunciation: 72, accuracy: 68, fluency: 85, completeness: 100, prosody: 55 },
  words: [
    { word: 'I', accuracy: 95, errorType: 'None', phonemes: [{ phoneme: 'aɪ', accuracy: 95 }] },
    {
      word: 'think', accuracy: 40, errorType: 'Mispronunciation',
      phonemes: [{ phoneme: 'θ', accuracy: 20 }, { phoneme: 'ɪ', accuracy: 90 }],
    },
    { word: 'so', accuracy: 90, errorType: 'None', phonemes: [{ phoneme: 's', accuracy: 92 }] },
  ],
};

test('本地摘要點出分數最低的面向，並指名唸不好的字與音素', () => {
  const text = localSummary(ASSESSMENT, { reason: 'disabled' });

  assert.match(text, /語調/);        // 55 是四個面向裡最低的
  assert.match(text, /55 分/);
  assert.match(text, /think/);
  assert.match(text, /θ/);           // 逐音素分數是關掉講評之後最有價值的東西
  assert.doesNotMatch(text, /\bI\b.*準確度偏低/); // 95 分的字不該被點名
});

test('每一種缺席原因給不一樣的說明', () => {
  const disabled = localSummary(ASSESSMENT, { reason: 'disabled' });
  const noKey = localSummary(ASSESSMENT, { reason: 'no_key' });
  const failed = localSummary(ASSESSMENT, { reason: 'failed' });

  // 「你自己關掉的」要講怎麼開回來，不能讓人以為壞了
  assert.match(disabled, /已關閉/);
  assert.match(disabled, /設定/);
  assert.doesNotMatch(disabled, /GEMINI_API_KEY/);

  assert.match(noKey, /GEMINI_API_KEY/);

  assert.match(failed, /沒有回來/);
  assert.match(failed, /分數不受影響/);

  assert.notEqual(disabled, noKey);
  assert.notEqual(disabled, failed);
});

test('沒指定原因時退回「沒設金鑰」的說法', () => {
  assert.equal(localSummary(ASSESSMENT), localSummary(ASSESSMENT, { reason: 'no_key' }));
  assert.equal(localSummary(ASSESSMENT, { reason: '亂寫' }), localSummary(ASSESSMENT));
});

test('都唸得好的時候講的是好消息，不是一片空白', () => {
  const text = localSummary({
    scores: { pronunciation: 96, accuracy: 95, fluency: 97, completeness: 100, prosody: 92 },
    words: [{ word: 'good', accuracy: 96, errorType: 'None', phonemes: [] }],
  }, { reason: 'disabled' });

  assert.match(text, /繼續保持/);
});

test('缺欄位不會炸 —— 這段是講評失敗時的退路，它自己不能再失敗一次', () => {
  assert.doesNotThrow(() => localSummary({}, { reason: 'failed' }));
  assert.doesNotThrow(() => localSummary(undefined, { reason: 'failed' }));
  assert.match(localSummary({ scores: {}, words: [] }, { reason: 'failed' }), /繼續保持/);
});

test('每一行都是條列 —— 畫面上是直接印出來的', () => {
  for (const line of localSummary(ASSESSMENT, { reason: 'disabled' }).split('\n')) {
    assert.ok(line.startsWith('•'), `這一行沒有以「•」開頭：${line}`);
  }
});
