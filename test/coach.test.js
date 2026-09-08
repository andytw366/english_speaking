// 情境對話的 AI 修正（server/coach.js）。
//
// 跟 `narrator.test.js` 一樣的處境：**真正的呼叫在開發容器裡跑不到**
// （egress 是逐主機允許清單）。所以這裡驗的是 prompt 帶了什麼、
// 模型各種不聽話的輸出解析得出什麼、以及送上來的東西怎麼擋。
//
// 解析那一段特別值得驗：模型不會照格式回，而**每一種不照格式**在畫面上
// 都是同一個症狀（「AI 修正沒出現」）—— 只有測試分得出是哪一種。
//
// 這裡**不 import server/index.js** —— 它一 import 就 app.listen()。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDialogueReviewPrompt, parseDialogueReview, parseReviewRequest,
  reviewDialogueAnswer, LIMITS, VERDICTS,
} from '../server/coach.js';

const TASK = {
  setting_zh: '你走進一家咖啡店，店員在櫃檯後面招呼你。',
  your_role_zh: '顧客',
  partner_role_zh: '店員',
  partner_line: 'Hi there! What can I get for you today?',
  intent_zh: '點一杯中杯拿鐵，外帶',
  reference: 'Can I get a medium latte to go, please?',
  accept: ['Can I get a medium latte to go, please?', "I'd like a medium latte to go, please."],
  input: 'I want one medium latte, take away.',
};

// ─── prompt ──────────────────────────────────────────────────────────────

test('prompt 帶得到情境、角色、對方剛剛說的話、意圖與參考說法', () => {
  // 少了情境的話模型只能就句子論句子，而同一句話在咖啡店與在藥局
  // 是完全不同的評語 —— 這條釘住「上下文真的有送出去」
  const prompt = buildDialogueReviewPrompt(TASK);
  assert.match(prompt, /咖啡店/);
  assert.match(prompt, /顧客/);
  assert.match(prompt, /店員/);
  assert.match(prompt, /What can I get for you today/);
  assert.match(prompt, /點一杯中杯拿鐵/);
  assert.match(prompt, /Can I get a medium latte to go/);
  assert.match(prompt, /I want one medium latte, take away/);
});

test('prompt 明講「不要把參考說法整句抄過來」', () => {
  // 不講的話回來的永遠是參考說法本身，而那個畫面上已經有了 ——
  // 使用者要知道的是**他自己那句**行不行
  const prompt = buildDialogueReviewPrompt(TASK);
  assert.match(prompt, /不要把教材的參考說法整句抄過來/);
  assert.match(prompt, /盡量貼近學習者原本的說法/);
});

test('跟參考說法重複的 accept 不會再列一次 —— 那只是把 prompt 撐長', () => {
  const prompt = buildDialogueReviewPrompt(TASK);
  assert.equal(prompt.match(/Can I get a medium latte to go/g).length, 1);
  assert.match(prompt, /I'd like a medium latte to go/);
});

test('缺欄位不會在 prompt 裡留下空行或「undefined」', () => {
  const prompt = buildDialogueReviewPrompt({ input: 'Thanks.' });
  assert.doesNotMatch(prompt, /undefined/);
  assert.doesNotMatch(prompt, /\n\n\n/);
  assert.match(prompt, /Thanks/);
});

// ─── 解析模型的輸出 ──────────────────────────────────────────────────────

test('照格式回來的東西解析得出三個欄位', () => {
  const raw = [
    '判定：小問題',
    "修正：Can I get a medium latte to go?",
    '• take away 是英式用法，美式店裡說 to go 比較常見。',
    '• I want… 在點餐時偏直接，Can I get… 更自然。',
  ].join('\n');

  assert.deepEqual(parseDialogueReview(raw, { input: TASK.input }), {
    corrected: 'Can I get a medium latte to go?',
    verdict: 'minor',
    notes: [
      'take away 是英式用法，美式店裡說 to go 比較常見。',
      'I want… 在點餐時偏直接，Can I get… 更自然。',
    ],
  });
});

test('markdown 圍欄、粗體、條列符號、全形半形冒號都收', () => {
  // 這些都是同一批模型的同一種壞習慣，收不到的症狀都是「AI 修正沒出現」
  const raw = [
    '```markdown',
    '- **判定**: 可以',
    '- **修正**: "Could I get a medium latte to go?"',
    '- 你的說法完全沒問題。',
    '```',
  ].join('\n');

  const out = parseDialogueReview(raw, { input: TASK.input });
  assert.equal(out.verdict, 'ok');
  assert.equal(out.corrected, 'Could I get a medium latte to go?');
  assert.deepEqual(out.notes, ['你的說法完全沒問題。']);
});

test('沒有判定那一行時，用「有沒有真的改動」推一個', () => {
  // 判定決定那張卡的顏色與標題，少了它整段會變成一塊沒有結論的文字
  const same = parseDialogueReview('修正：I want one medium latte, take away.', { input: TASK.input });
  assert.equal(same.verdict, 'ok');

  const changed = parseDialogueReview('修正：Can I get a medium latte to go?', { input: TASK.input });
  assert.equal(changed.verdict, 'minor');
});

test('只差標點與大小寫不算改動', () => {
  const out = parseDialogueReview('修正：I want one medium latte, take away!', { input: TASK.input });
  assert.equal(out.verdict, 'ok');
});

test('「小問題（意思可以懂）」判成 minor，不是 ok', () => {
  // 那一行同時中「小問題」與「可以」。先比壞的那幾個才不會判成完全沒問題
  const out = parseDialogueReview('判定：小問題（意思可以懂）\n修正：Can I get a latte?');
  assert.equal(out.verdict, 'minor');
});

test('「修正：無需修正」不算句子 —— 那顯示出來只會讓人以為壞了', () => {
  const out = parseDialogueReview('判定：可以\n修正：無需修正\n• 這句話很自然。');
  assert.equal(out.corrected, null);
  assert.equal(out.verdict, 'ok');
  assert.deepEqual(out.notes, ['這句話很自然。']);
});

test('說明最多三點', () => {
  const raw = ['判定：要改', '修正：Fix it.', ...['a', 'b', 'c', 'd', 'e'].map((x) => `• ${x}`)].join('\n');
  assert.equal(parseDialogueReview(raw).notes.length, 3);
});

test('只有修正、或只有說明，都還是有東西可以顯示', () => {
  assert.equal(parseDialogueReview('修正：Can I get a latte?').corrected, 'Can I get a latte?');
  assert.deepEqual(parseDialogueReview('• 這樣說沒問題。').notes, ['這樣說沒問題。']);
});

test('完全整理不出東西時回 null，讓畫面說「這次沒回來」', () => {
  assert.equal(parseDialogueReview('這一段完全沒有格式，只是一段散文。'), null);
  assert.equal(parseDialogueReview(''), null);
  assert.equal(parseDialogueReview(null), null);
  assert.equal(parseDialogueReview(undefined), null);
  assert.equal(parseDialogueReview({ corrected: 'x' }), null);
});

test('判定只會是那三個字之一', () => {
  for (const raw of ['判定：可以', '判定：小問題', '判定：要改', '判定：亂寫的東西']) {
    const out = parseDialogueReview(`${raw}\n修正：Something.`);
    assert.ok(VERDICTS.includes(out.verdict), `${raw} → ${out.verdict}`);
  }
});

// ─── 送上來的東西 ────────────────────────────────────────────────────────

test('空白的答案擋下來 —— 沒有東西可以改，而那仍然是一次呼叫', () => {
  for (const input of ['', '   ', undefined, null, 42]) {
    const out = parseReviewRequest({ input, reference: 'x' });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'no_input');
  }
});

test('過長的欄位截掉而不是回錯誤', () => {
  // 這些是教材內容或使用者自己打的句子，正常情況下離上限很遠 ——
  // 會超過就代表有人在亂送，截掉之後模型照樣看得懂
  const out = parseReviewRequest({
    input: 'a'.repeat(5000),
    reference: 'b'.repeat(5000),
    setting_zh: 'c'.repeat(5000),
  });
  assert.equal(out.ok, true);
  assert.equal(out.task.input.length, LIMITS.input);
  assert.equal(out.task.reference.length, LIMITS.reference);
  assert.equal(out.task.setting_zh.length, LIMITS.setting);
});

test('accept 只收字串、而且有數量上限', () => {
  const out = parseReviewRequest({
    input: 'Hi.',
    accept: ['a', 2, null, 'b', 'c', 'd', 'e'],
  });
  assert.deepEqual(out.task.accept, ['a', 'b', 'c']);
});

test('accept 不是陣列也不會爆掉', () => {
  assert.deepEqual(parseReviewRequest({ input: 'Hi.', accept: 'nope' }).task.accept, []);
  assert.deepEqual(parseReviewRequest({ input: 'Hi.' }).task.accept, []);
});

// ─── 真的要一次修正（假的 complete）──────────────────────────────────────

test('回來的文字會被解析，prompt 有送出去', async () => {
  const seen = [];
  const out = await reviewDialogueAnswer(TASK, {
    completeImpl: async (prompt, options) => {
      seen.push({ prompt, options });
      return '判定：小問題\n修正：Can I get a medium latte to go?\n• to go 比 take away 常見。';
    },
  });

  assert.equal(out.verdict, 'minor');
  assert.equal(out.corrected, 'Can I get a medium latte to go?');
  assert.match(seen[0].prompt, /咖啡店/);
  // 一句英文加兩行中文而已 —— 額度開太大只會讓模型寫成一篇作文
  assert.ok(seen[0].options.maxTokens <= 400);
});

test('沒有可用的模型（complete 回 null）時回 null，不丟例外', async () => {
  // 本地批改與參考答案已經在畫面上了，這裡丟例外會讓整個模式當掉
  assert.equal(await reviewDialogueAnswer(TASK, { completeImpl: async () => null }), null);
});

test('模型回一段散文時回 null —— 畫面上會說「這次沒回來」', async () => {
  const out = await reviewDialogueAnswer(TASK, {
    completeImpl: async () => '你好！這句話大致上沒有問題喔，繼續加油！',
  });
  assert.equal(out, null);
});
