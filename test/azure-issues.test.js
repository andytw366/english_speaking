// Azure 評估 → 弱點音分類的回歸測試。不需要網路與金鑰。
//
// 這是整合兩個分支的接點：Azure 給客觀分數，這裡把它翻成分類，
// practice.js 再拿分類去加權抽句。對錯了不會有任何錯誤訊息 ——
// 只會讓「多給你 th 的句子」變成多給你別的音，從畫面上看不出來。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  issueForWord,
  problemWordsFromAssessment,
  prosodyIssue,
  PHONEME_THRESHOLD,
} from '../public/lib/azure-issues.js';
import { ISSUE_CODES } from '../server/gemini.js';

/** 造一個 Azure 的字。phonemes 是 [IPA, 分數] 的清單。 */
const word = (text, accuracy, phonemes = [], errorType = 'None') => ({
  word: text,
  accuracy,
  errorType,
  phonemes: phonemes.map(([phoneme, acc]) => ({ phoneme, accuracy: acc })),
});

test('θ 唸不好會被歸成 th', () => {
  assert.equal(issueForWord(word('think', 45, [['θ', 20], ['ɪ', 90], ['ŋ', 95], ['k', 90]])), 'th');
});

test('ð 也算 th', () => {
  assert.equal(issueForWord(word('the', 40, [['ð', 25], ['ə', 88]])), 'th');
});

test('l 或 ɹ 唸不好歸成 r_l', () => {
  assert.equal(issueForWord(word('really', 50, [['ɹ', 30], ['ɪ', 90], ['l', 88], ['i', 90]])), 'r_l');
  assert.equal(issueForWord(word('little', 52, [['l', 35], ['ɪ', 92], ['t', 90]])), 'r_l');
});

test('v 或 w 唸不好歸成 v_w', () => {
  assert.equal(issueForWord(word('very', 48, [['v', 22], ['ɛ', 90], ['ɹ', 85], ['i', 90]])), 'v_w');
});

test('ŋ 唸不好歸成 n_ng，但單純的 n 不會', () => {
  assert.equal(issueForWord(word('sing', 50, [['s', 90], ['ɪ', 88], ['ŋ', 30]])), 'n_ng');
  // n 在英文裡太常見，收進來會把所有問題都算成 n_ng —— 寧可漏抓不要亂抓
  const nOnly = issueForWord(word('none', 55, [['n', 30], ['ʌ', 90], ['n', 85]]));
  assert.notEqual(nOnly, 'n_ng');
});

test('IPA 的長度與重音記號不影響查表', () => {
  // iː 與 i 都對應長短母音；ˈ 沒去掉的話會查不到
  assert.equal(issueForWord(word('seat', 50, [['s', 92], ['ˈiː', 35], ['t', 88]])), 'vowel_length');
});

test('字尾塞音沒發出來歸成 final_consonant', () => {
  assert.equal(
    issueForWord(word('cat', 55, [['k', 92], ['æ', 90], ['t', 25]])),
    'final_consonant'
  );
});

test('字尾塞音的判斷不會蓋掉更具體的音素問題', () => {
  // th 跟字尾的 t 都弱時，要報 th —— 具體的音比「字尾子音」有用
  assert.equal(
    issueForWord(word('third', 40, [['θ', 20], ['ɝ', 88], ['d', 30]])),
    'th'
  );
});

test('errorType 對應到 stress 與 linking', () => {
  assert.equal(issueForWord(word('the', 90, [], 'Monotone')), 'stress');
  assert.equal(issueForWord(word('and', 90, [], 'UnexpectedBreak')), 'linking');
  assert.equal(issueForWord(word('and', 90, [], 'MissingBreak')), 'linking');
});

test('有問題但歸不到任何一類時回 other，不是 null', () => {
  // 回 null 的話這個字就完全消失，使用者會覺得系統漏看了
  assert.equal(issueForWord(word('hmm', 40, [['h', 30], ['ʌ', 45]])), 'other');
});

test('沒有問題的字回 null', () => {
  assert.equal(issueForWord(word('good', 95, [['ɡ', 96], ['ʊ', 94], ['d', 93]])), null);
  assert.equal(issueForWord(null), null);
  assert.equal(issueForWord({}), null);
});

test('門檻剛好在邊界上不算有問題', () => {
  const atThreshold = word('x', 95, [['θ', PHONEME_THRESHOLD]]);
  assert.equal(issueForWord(atThreshold), null);
});

test('每個對應出來的代碼都在 ISSUE_CODES 裡', () => {
  // 代碼會被拿去查中文標籤，漏一個沒對應的就會讓代碼原文出現在畫面上
  const samples = [
    word('a', 40, [['θ', 20]]), word('b', 40, [['ɹ', 20], ['l', 30]]),
    word('c', 40, [['v', 20], ['w', 25]]), word('d', 40, [['ŋ', 20]]),
    word('e', 40, [['ɪ', 20]]), word('f', 40, [['k', 92], ['æ', 90], ['t', 20]]),
    word('g', 90, [], 'Monotone'), word('h', 90, [], 'UnexpectedBreak'),
    word('i', 40, [['h', 20]]),
  ];
  for (const w of samples) {
    const issue = issueForWord(w);
    assert.ok(ISSUE_CODES.includes(issue), `${w.word} 對到了未知代碼 ${issue}`);
  }
});

// ─── problemWordsFromAssessment ─────────────────────────────────────────

test('形狀跟 Gemini 路徑一致，這樣紀錄只要一段程式讀得懂', () => {
  const assessment = {
    referenceText: 'I think so.',
    words: [word('think', 45, [['θ', 20], ['ɪ', 90]])],
  };
  const [item] = problemWordsFromAssessment(assessment);
  assert.deepEqual(Object.keys(item).sort(), ['accuracy', 'heard', 'issue', 'tip_zh', 'word']);
  assert.equal(item.word, 'think');
  assert.equal(item.issue, 'th');
  // heard 留空是誠實的：Azure 給分數，不給「你唸成了什麼」
  assert.equal(item.heard, '');
});

test('分數最低的排前面，而且最多三個', () => {
  const assessment = {
    words: [
      word('a', 70, [['θ', 55]]), word('b', 30, [['ɹ', 20], ['l', 25]]),
      word('c', 50, [['v', 40], ['w', 45]]), word('d', 60, [['ŋ', 50]]),
      word('e', 95, [['ɡ', 96]]),
    ],
  };
  const items = problemWordsFromAssessment(assessment);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((x) => x.word), ['b', 'c', 'd']);
});

test('漏字（Omission）不列進弱點', () => {
  // 那是「沒唸」不是「唸錯」，混在一起會讓弱點統計失真
  const assessment = { words: [word('skipped', 0, [], 'Omission'), word('think', 45, [['θ', 20]])] };
  const items = problemWordsFromAssessment(assessment);
  assert.deepEqual(items.map((x) => x.word), ['think']);
});

test('壞掉或全對的輸入回空陣列', () => {
  assert.deepEqual(problemWordsFromAssessment(null), []);
  assert.deepEqual(problemWordsFromAssessment({}), []);
  assert.deepEqual(problemWordsFromAssessment({ words: [word('ok', 96, [['ɡ', 95]])] }), []);
});

test('語調分數很低時補一筆 stress', () => {
  // prosody 是整句的分數，不掛在任何字上；不記錄的話抽句永遠不會多給重音難的句子
  assert.equal(prosodyIssue({ scores: { prosody: 40 }, referenceText: 'Hello there.' }).issue, 'stress');
  assert.equal(prosodyIssue({ scores: { prosody: 85 } }), null);
  assert.equal(prosodyIssue({ scores: {} }), null);
  assert.equal(prosodyIssue(null), null);
});
