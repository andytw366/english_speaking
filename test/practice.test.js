// 抽句加權與練習紀錄彙整的回歸測試。不需要瀏覽器、網路或金鑰。
//
// 這裡在意的是兩個方向（跟 audio.test.js 同一個思路）：
// **該被優先抽到的要真的比較常被抽到**，以及
// **練得好的句子不可以完全抽不到** —— 後者調過頭比沒有加權還糟。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sentenceStats,
  scoreWeight,
  sentenceWeight,
  reviewIntervalHours,
  dueFactor,
  pickSentence,
  trendPoints,
  DUE_MIN,
  DUE_MAX,
  SRS_BASE_HOURS,
} from '../public/practice.js';

/**
 * 測試裡的「現在」。
 *
 * 一定要注入而不是用 Date.now()：加權現在會看「上次練是多久以前」，
 * 用真實時鐘的話，同一份紀錄在不同日子跑出來的權重不一樣，
 * 測試就會隨著時間慢慢變成另一個測試。
 */
const NOW = Date.UTC(2026, 0, 1, 12, 0);

/** 產生一筆練習紀錄。`minutesAgo` 越小代表越新。 */
const rec = (sentenceId, score, minutesAgo = 0) => ({
  sentenceId,
  score,
  at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  sentenceText: `sentence ${sentenceId}`,
});

/** 十天前。久到不管幾分都「早就該複習了」，這樣才測得出純粹的分數效果。 */
const LONG_AGO = 10 * 24 * 60;

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

// ─── scoreWeight（只看分數的那一半）──────────────────────────────────────

test('scoreWeight：沒練過的句子權重高於練得好的、低於練得爛的', () => {
  const never = scoreWeight(undefined);
  const good = scoreWeight({ average: 95, count: 3 });
  const bad = scoreWeight({ average: 40, count: 3 });

  assert.ok(good < never, `練得好(${good}) 應該低於沒練過(${never})`);
  assert.ok(never < bad, `沒練過(${never}) 應該低於練得爛(${bad})`);
});

test('scoreWeight：分數越低權重越高，且落在 1～5 之間', () => {
  const weights = [0, 25, 50, 75, 100].map((average) => scoreWeight({ average, count: 1 }));

  for (let i = 1; i < weights.length; i += 1) {
    assert.ok(weights[i] < weights[i - 1], `權重要隨分數遞減：${weights}`);
  }
  assert.equal(weights.at(-1), 1); // 100 分
  assert.equal(weights[0], 5); // 0 分
});

test('scoreWeight：極端分數不會讓權重爆掉或變成 0', () => {
  // 分數理論上是 0～100，但紀錄是使用者瀏覽器裡的資料，手改過也不能讓抽句壞掉
  assert.equal(scoreWeight({ average: 500 }), 1);
  assert.equal(scoreWeight({ average: -500 }), 5);
  assert.equal(scoreWeight({ average: 'x' }), 3);
  assert.equal(scoreWeight({ average: NaN }), 3);
});

// ─── 間隔重複（時間的那一半）────────────────────────────────────────────

/** 建一個「n 小時前練的、平均 average 分」的統計。 */
const stat = (average, hoursAgo) => ({
  average,
  count: 2,
  last: average,
  lastAt: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
});

test('reviewIntervalHours：每差 25 分間隔就差一倍', () => {
  assert.equal(reviewIntervalHours(50), SRS_BASE_HOURS);
  assert.equal(reviewIntervalHours(75), SRS_BASE_HOURS * 2);
  assert.equal(reviewIntervalHours(100), SRS_BASE_HOURS * 4);
  assert.equal(reviewIntervalHours(25), SRS_BASE_HOURS / 2);
  assert.equal(reviewIntervalHours(0), SRS_BASE_HOURS / 4);
  // 壞掉的資料當成中間值，不要讓間隔變成 NaN
  assert.equal(reviewIntervalHours('x'), SRS_BASE_HOURS);
  assert.equal(reviewIntervalHours(999), SRS_BASE_HOURS * 4);
});

test('dueFactor：沒練過的句子當作完全該練', () => {
  assert.equal(dueFactor(undefined, NOW), 1);
});

test('dueFactor：時間壞掉的紀錄也當作該練，不會變成 NaN 讓那句永遠抽不到', () => {
  // localStorage 是使用者改得動的，時間字串不能假設一定合法
  assert.equal(dueFactor({ average: 50, lastAt: 'not a date' }, NOW), 1);
  assert.equal(dueFactor({ average: 50 }, NOW), 1);
});

test('dueFactor：剛練完最低、越久越高，而且不會超出上下限', () => {
  const series = [0, 1, 6, 24, 72, 24 * 30, 24 * 365].map((h) => dueFactor(stat(50, h), NOW));

  for (let i = 1; i < series.length; i += 1) {
    assert.ok(series[i] >= series[i - 1], `越久沒練係數要越高：${series}`);
  }
  assert.ok(series[4] > series[1], `中段要有實際的差距：${series}`);
  assert.equal(series[0], DUE_MIN);
  // 放一年的話 e^-x 已經小到浮點數看不出來，剛好等於上限；重點是不會超過
  assert.ok(series.at(-1) <= DUE_MAX, `不能超過上限 ${DUE_MAX}：${series.at(-1)}`);
});

test('dueFactor：未來時間（時鐘被調過）當成剛練完，不會給出負的或爆掉的係數', () => {
  assert.equal(dueFactor(stat(50, -100), NOW), DUE_MIN);
});

test('sentenceWeight：剛練完的句子會被壓下去，但不會變成 0', () => {
  const justNow = sentenceWeight(stat(20, 0), NOW);
  const yesterday = sentenceWeight(stat(20, 24), NOW);

  assert.ok(justNow > 0, '壓低不等於歸零，不然那句會再也抽不到');
  assert.ok(yesterday > justNow * 3, `隔一天要明顯回升：${justNow} → ${yesterday}`);
});

test('sentenceWeight：分數高的句子要隔比較久才會回到同樣的權重', () => {
  // 這是間隔重複的重點：練得好的句子不是消失，是「等比較久才回來」
  const lowAfterADay = sentenceWeight(stat(20, 24), NOW);
  const highAfterADay = sentenceWeight(stat(95, 24), NOW);
  const highAfterTwoWeeks = sentenceWeight(stat(95, 24 * 14), NOW);

  assert.ok(highAfterADay < lowAfterADay, '同樣隔一天，練得好的不該比練得爛的更常出現');
  assert.ok(highAfterTwoWeeks > highAfterADay * 2, '放兩個星期後要自己回來');
});

test('sentenceWeight：久沒練的高分句子，會排在剛練完的低分句子前面', () => {
  // 只看分數的舊版做不到這件事 —— 剛練完的低分句子會一直卡在最前面
  const staleHigh = sentenceWeight(stat(90, 24 * 14), NOW);
  const freshLow = sentenceWeight(stat(10, 0), NOW);

  assert.ok(staleHigh > freshLow, `${staleHigh} 應該大於 ${freshLow}`);
});

test('pickSentence：同一輪裡不會一直卡在剛練完的那句', () => {
  // excludeId 只擋得住「連續兩次同一句」，擋不住「abababab」。
  // 這裡驗的是時間係數確實有把剛練完的句子壓下去。
  const stats = new Map([
    ['a', stat(20, 0)], // 剛練完，分數很低
    ['b', stat(20, 0)], // 同上
  ]);
  const pool = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]; // c 沒練過

  let hitC = 0;
  for (let i = 0; i < 2000; i += 1) {
    if (pickSentence(pool, { stats, now: NOW }).id === 'c') hitC += 1;
  }
  // 權重 a=b=1.25、c=3 → c 約占 55%
  assert.ok(hitC > 800, `沒練過的句子要有機會插隊，實際 ${hitC} / 2000`);
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
  // 兩句都是十天前練的，時間因素在這裡打平，剩下的差距純粹來自分數
  const history = [
    ...Array.from({ length: 3 }, (_, i) => rec('a', 95, LONG_AGO + i)),
    ...Array.from({ length: 3 }, (_, i) => rec('b', 30, LONG_AGO + i + 10)),
  ];
  const stats = sentenceStats(history);

  const counts = { a: 0, b: 0, c: 0 };
  // 固定亂數序列，讓這個測試不會偶爾紅一次
  let seed = 1;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 3000; i += 1) {
    counts[pickSentence(POOL, { stats, random, now: NOW }).id] += 1;
  }

  // 基礎權重：a=1.2（95 分）、b=3.8（30 分）、c=3（沒練過）
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

  // 最壞的情況：a 剛剛才練完（時間係數壓到最低 0.25）、而且是滿分（分數權重 1）
  let hitA = 0;
  for (let i = 0; i < 2000; i += 1) {
    if (pickSentence(POOL, { stats, now: NOW }).id === 'a') hitA += 1;
  }
  assert.ok(hitA > 20, `100 分又剛練完的句子還是要抽得到，實際 ${hitA} / 2000`);
});

test('pickSentence：關掉加權時每一句的機率一樣', () => {
  const stats = sentenceStats(Array.from({ length: 20 }, (_, i) => rec('a', 0, i)));

  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 3000; i += 1) {
    counts[pickSentence(POOL, { stats, weighted: false, now: NOW }).id] += 1;
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
