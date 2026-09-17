// 結果卡最上面那一句是誰說的（`public/lib/verdict.js`）。
//
// 為什麼值得測：這是一個**五種狀態的挑選**，而每一種挑錯的代價都不一樣 ——
// 挑錯成本地的話，使用者會看到一個跟 AI 那一行互相打臉的判定；挑錯成 AI 的話，
// 會拿上一題（或根本不存在）的判定當這一題的結論。兩種都不會炸，只會安靜地騙人。
//
// 純函式，不需要瀏覽器、網路與金鑰。

import test from 'node:test';
import assert from 'node:assert/strict';

import { pickVerdict, isPass, AI_HEAD, WAITING_HEAD } from '../public/lib/verdict.js';
import { RESULT_HEAD } from '../public/lib/grade.js';

// reviewer 在畫面上長什麼樣不重要，pickVerdict 只讀這兩個欄位
const ai = (phase, verdict = null) => ({ phase, verdict });

test('模型看過了就以模型的判定為準', () => {
  for (const verdict of ['ok', 'minor', 'major']) {
    const got = pickVerdict(ai('done', verdict), { level: 'wrong' });
    assert.equal(got.source, 'ai');
    assert.equal(got.title, AI_HEAD[verdict][0]);
    assert.equal(got.tone, AI_HEAD[verdict][1]);
  }
});

test('判定的標題裡要寫著 AI —— 使用者要知道這句話是誰說的', () => {
  for (const [title] of Object.values(AI_HEAD)) {
    assert.match(title, /AI/);
  }
});

test('模型說可以、本地說再想想時，聽模型的（這正是要修掉的那個打臉畫面）', () => {
  const got = pickVerdict(ai('done', 'ok'), { level: 'wrong', missing: ['latte'] });
  assert.equal(got.source, 'ai');
  assert.equal(got.tone, 'ok');
});

test('還在等模型時給的是中性的一句話，不是等一下會被推翻的判定', () => {
  const got = pickVerdict(ai('loading'), { level: 'wrong' });
  assert.equal(got.source, 'waiting');
  assert.deepEqual([got.title, got.tone], WAITING_HEAD);
  // 綠或紅都會被當成結論，而這時候還沒有結論
  assert.notEqual(got.tone, 'ok');
  assert.notEqual(got.tone, 'bad');
});

test('模型沒看的每一種情況都退回本地三級', () => {
  // 關掉／手動還沒按（idle）、這次沒回來（error）、整理不出判定（done 但沒有 verdict）
  for (const state of [ai('idle'), ai('error'), ai('done', null), null, undefined]) {
    const got = pickVerdict(state, { level: 'close' });
    assert.equal(got.source, 'local', `這個狀態挑錯了：${JSON.stringify(state)}`);
    assert.equal(got.title, RESULT_HEAD.close[0]);
  }
});

test('本地的三級各自對到自己的標題與顏色', () => {
  for (const level of ['exact', 'close', 'wrong']) {
    const got = pickVerdict(ai('idle'), { level });
    assert.deepEqual([got.title, got.tone], RESULT_HEAD[level]);
  }
});

test('空白作答一律是「請先寫下答案」，就算模型那邊還留著上一句的判定', () => {
  // 空白不會去要修正（見 ai-review.js 的 begin()），所以 done 的那一份
  // 講的是別句話 —— 拿來用會變成「我什麼都沒寫卻被說這樣說可以」
  const got = pickVerdict(ai('done', 'ok'), { level: 'empty' });
  assert.equal(got.source, 'local');
  assert.equal(got.title, RESULT_HEAD.empty[0]);
});

test('level 壞掉或沒有時不會炸，也不會給出 undefined 的標題', () => {
  for (const local of [null, undefined, {}, { level: '???' }]) {
    const got = pickVerdict(ai('idle'), local);
    assert.equal(typeof got.title, 'string');
    assert.ok(got.title);
    assert.equal(typeof got.tone, 'string');
  }
});

// ─── 情境對話的「幾句表達到位」────────────────────────────────────────────

test('模型判可以與小問題都算表達到位，要改不算', () => {
  assert.equal(isPass({ aiVerdict: 'ok', level: 'wrong' }), true);
  assert.equal(isPass({ aiVerdict: 'minor', level: 'wrong' }), true);
  assert.equal(isPass({ aiVerdict: 'major', level: 'exact' }), false);
});

test('沒有模型判定時才看本地的三級', () => {
  assert.equal(isPass({ level: 'exact' }), true);
  assert.equal(isPass({ level: 'close' }), true);
  assert.equal(isPass({ level: 'wrong' }), false);
  assert.equal(isPass({ level: 'empty' }), false);
});

test('空的一格不算到位，也不會炸', () => {
  for (const said of [null, undefined, {}, { aiVerdict: null }]) {
    assert.equal(isPass(said), false);
  }
});

test('總結算的跟卡片上寫的是同一件事', () => {
  // 同一句話在卡片上說「可以」、在總結裡算沒過關的話，那個數字就沒有意義了
  const said = { input: 'I want one medium latte, take away.', level: 'wrong', aiVerdict: 'ok' };
  assert.equal(pickVerdict(ai('done', said.aiVerdict), { level: said.level }).tone, 'ok');
  assert.equal(isPass(said), true);
});
