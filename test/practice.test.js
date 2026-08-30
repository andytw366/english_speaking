// 抽句加權與練習紀錄彙整的回歸測試。不需要瀏覽器、網路或金鑰。
//
// 這裡在意的是兩個方向（跟 audio.test.js 同一個思路）：
// **該被優先抽到的要真的比較常被抽到**，以及
// **練得好的句子不可以完全抽不到** —— 後者調過頭比沒有加權還糟。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sentenceStats,
  sentenceWeight,
  pickSentence,
  trendPoints,
} from '../public/practice.js';

/** 產生一筆練習紀錄。`at` 越大代表越新。 */
const rec = (sentenceId, score, minutesAgo = 0) => ({
  sentenceId,
  score,
  at: new Date(Date.UTC(2026, 0, 1, 12, 0) - minutesAgo * 60_000).toISOString(),
  sentenceText: `sentence ${sentenceId}`,
});

// ─── sentenceStats ──────────────────────────────────────────────────────

test('sentenceStats：同一句的多筆紀錄會算成次數與平均', () => {
  const stats = sentenceStats([rec('a', 60), rec('a', 80, 10), rec('b', 90, 20)]);

  assert.equal(stats.size, 2);
  assert.equal(stats.get('a').count, 2);
  assert.equal(stats.get('a').average, 70);
  assert.equal(stats.get('b').count, 1);
  assert.equal(stats.get('b').average, 90);
});

test('sentenceStats：last 取的是最近一次，不是最高或最低', () => {
  // history 由新到舊，所以第一筆（95）才是最近一次
  const stats = sentenceStats([rec('a', 95), rec('a', 20, 10)]);

  assert.equal(stats.get('a').last, 95);
  assert.equal(stats.get('a').average, 58); // (95+20)/2 = 57.5 → 58
});

test('sentenceStats：沒有分數或壞掉的紀錄不會被算進去', () => {
  const stats = sentenceStats([
    rec('a', 70),
    { sentenceId: 'a' }, // 沒有 score（例如無人聲那種紀錄）
    { score: 50 }, // 沒有 sentenceId
    null,
  ]);

  assert.equal(stats.size, 1);
  assert.equal(stats.get('a').count, 1);
});

test('sentenceStats：沒有紀錄或參數不是陣列時回空 Map，不會丟例外', () => {
  assert.equal(sentenceStats([]).size, 0);
  assert.equal(sentenceStats(undefined).size, 0);
});

// ─── sentenceWeight ─────────────────────────────────────────────────────

test('sentenceWeight：沒練過的句子權重高於練得好的、低於練得爛的', () => {
  const never = sentenceWeight(undefined);
  const good = sentenceWeight({ average: 95, count: 3 });
  const bad = sentenceWeight({ average: 40, count: 3 });

  assert.ok(good < never, `練得好(${good}) 應該低於沒練過(${never})`);
  assert.ok(never < bad, `沒練過(${never}) 應該低於練得爛(${bad})`);
});

test('sentenceWeight：分數越低權重越高，且落在 1～5 之間', () => {
  const weights = [0, 25, 50, 75, 100].map((average) => sentenceWeight({ average, count: 1 }));

  for (let i = 1; i < weights.length; i += 1) {
    assert.ok(weights[i] < weights[i - 1], `權重要隨分數遞減：${weights}`);
  }
  assert.equal(weights.at(-1), 1); // 100 分
  assert.equal(weights[0], 5); // 0 分
});

test('sentenceWeight：極端分數不會讓權重爆掉或變成 0', () => {
  // 分數理論上是 0～100，但紀錄是使用者瀏覽器裡的資料，手改過也不能讓抽句壞掉
  assert.equal(sentenceWeight({ average: 500 }), 1);
  assert.equal(sentenceWeight({ average: -500 }), 5);
  assert.equal(sentenceWeight({ average: 'x' }), 3);
});

// ─── pickSentence ───────────────────────────────────────────────────────

const POOL = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('pickSentence：空池子回 null', () => {
  assert.equal(pickSentence([]), null);
  assert.equal(pickSentence(undefined), null);
});

test('pickSentence：池子多於一句時不會抽到剛練完的那句', () => {
  for (let i = 0; i < 50; i += 1) {
    const picked = pickSentence(POOL, { excludeId: 'a' });
    assert.notEqual(picked.id, 'a');
  }
});

test('pickSentence：池子只剩一句時照樣回那句（不能回 null）', () => {
  const picked = pickSentence([{ id: 'a' }], { excludeId: 'a' });
  assert.equal(picked.id, 'a');
});

test('pickSentence：加權後練得差的句子明顯比較常被抽到', () => {
  const history = [
    ...Array.from({ length: 3 }, (_, i) => rec('a', 95, i)),
    ...Array.from({ length: 3 }, (_, i) => rec('b', 30, i + 10)),
  ];
  const stats = sentenceStats(history);

  const counts = { a: 0, b: 0, c: 0 };
  // 固定亂數序列，讓這個測試不會偶爾紅一次
  let seed = 1;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 3000; i += 1) counts[pickSentence(POOL, { stats, random }).id] += 1;

  // 權重：a=1.2（95 分）、b=3.8（30 分）、c=3（沒練過）
  assert.ok(counts.b > counts.a * 2, `練得差的要明顯比較多：${JSON.stringify(counts)}`);
  assert.ok(counts.c > counts.a, `沒練過的也要比練得好的多：${JSON.stringify(counts)}`);
});

test('pickSentence：練得好的句子仍然抽得到，不會被完全擠掉', () => {
  // 這是「加權調過頭」的防線 —— 某幾句再也抽不到，比沒有加權還糟
  const stats = sentenceStats([
    ...Array.from({ length: 20 }, (_, i) => rec('a', 100, i)),
    ...Array.from({ length: 20 }, (_, i) => rec('b', 0, i + 30)),
    ...Array.from({ length: 20 }, (_, i) => rec('c', 0, i + 60)),
  ]);

  let hitA = 0;
  for (let i = 0; i < 2000; i += 1) {
    if (pickSentence(POOL, { stats }).id === 'a') hitA += 1;
  }
  // 期望值約 1/(1+5+5) = 9%，抓一個寬鬆的下限即可
  assert.ok(hitA > 40, `100 分的句子還是要抽得到，實際 ${hitA} / 2000`);
});

test('pickSentence：關掉加權時每一句的機率一樣', () => {
  const stats = sentenceStats(Array.from({ length: 20 }, (_, i) => rec('a', 0, i)));

  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 3000; i += 1) {
    counts[pickSentence(POOL, { stats, weighted: false }).id] += 1;
  }
  // 等機率下每句約 1000，就算 a 的平均是 0 分也不該被特別偏好
  for (const id of ['a', 'b', 'c']) {
    assert.ok(counts[id] > 800 && counts[id] < 1200, `應該接近等機率：${JSON.stringify(counts)}`);
  }
});

test('pickSentence：random() 回傳邊界值時不會回 undefined', () => {
  // Math.random() 不會回 1，但注入的亂數來源可能會 —— 這裡守的是索引越界
  assert.ok(pickSentence(POOL, { random: () => 0.999999999 }));
  assert.ok(pickSentence(POOL, { random: () => 1 }));
  assert.ok(pickSentence(POOL, { random: () => 0, weighted: false }));
  assert.ok(pickSentence(POOL, { random: () => 1, weighted: false }));
});

// ─── trendPoints ────────────────────────────────────────────────────────

test('trendPoints：由舊到新（圖是往右長的）', () => {
  const points = trendPoints([rec('a', 90), rec('b', 80, 10), rec('c', 70, 20)]);

  assert.deepEqual(points.map((p) => p.score), [70, 80, 90]);
});

test('trendPoints：只取最近 limit 筆，且跳過沒有分數的紀錄', () => {
  const history = [
    { sentenceId: 'x' }, // 沒有分數
    ...Array.from({ length: 30 }, (_, i) => rec('a', i, i)),
  ];

  const points = trendPoints(history, 5);
  assert.equal(points.length, 5);
  // 最近 5 筆是 score 0～4，反轉後最後一個是最新的 0
  assert.deepEqual(points.map((p) => p.score), [4, 3, 2, 1, 0]);
});

test('trendPoints：沒有紀錄時回空陣列', () => {
  assert.deepEqual(trendPoints([]), []);
  assert.deepEqual(trendPoints(undefined), []);
});
