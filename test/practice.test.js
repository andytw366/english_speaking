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
  dayKey,
  streakFromDays,
  summariseSet,
  weakIssues,
  focusBoost,
  matchedWeakIssues,
  WEAK_WINDOW,
} from '../public/lib/practice.js';

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

// ─── 每日目標與連續天數 ──────────────────────────────────────────────────
//
// 一律注入 now。這幾個函式全部跟「今天是哪一天」有關，
// 用真實時鐘的話測試會在半夜跑的時候紅一次，然後隔天自己好了 —— 最難查的那種。

/** 本地時間 n 天前的中午。用中午避開午夜與日光節約的邊界。 */
const noonDaysAgo = (daysAgo, base = new Date(2026, 7, 30, 20, 0)) => {
  const date = new Date(base);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(12, 0, 0, 0);
  return { at: date.toISOString(), score: 70, sentenceId: `s${daysAgo}` };
};

const NOW_LOCAL = new Date(2026, 7, 30, 20, 0).getTime();

test('dayKey：用本地時間切一天，壞掉的時間回空字串', () => {
  // 用 UTC 切的話，台灣時間晚上八點以後練的都會被算成隔天
  assert.equal(dayKey(new Date(2026, 7, 30, 23, 30)), '2026-08-30');
  assert.equal(dayKey(new Date(2026, 7, 1, 0, 5)), '2026-08-01');
  assert.equal(dayKey('not a date'), '');
  assert.equal(dayKey(undefined), '');
});

// 連續天數吃的是一組 dayKey（計數表整理出來的），六個模式共用同一份算法。
const daySet = (...offsets) => new Set(offsets.map((n) => dayKey(new Date(NOW_LOCAL - n * 864e5))));

test('streakFromDays：連續三天就是 3', () => {
  assert.equal(streakFromDays(daySet(0, 1, 2), NOW_LOCAL), 3);
});

test('streakFromDays：今天還沒練不會馬上歸零，從昨天往回算', () => {
  // 早上打開看到「連續 0 天」，正好是最不該讓人放棄的時間點
  assert.equal(streakFromDays(daySet(1, 2), NOW_LOCAL), 2);
});

test('streakFromDays：斷了就是 0（前天以前才練過）', () => {
  assert.equal(streakFromDays(daySet(2, 3), NOW_LOCAL), 0);
});

test('streakFromDays：中間缺一天就停在缺口', () => {
  assert.equal(streakFromDays(daySet(0, 1, 3, 4), NOW_LOCAL), 2);
});

test('streakFromDays：沒有資料、或型別不對時是 0，不會丟例外', () => {
  assert.equal(streakFromDays(new Set(), NOW_LOCAL), 0);
  assert.equal(streakFromDays(undefined, NOW_LOCAL), 0);
  assert.equal(streakFromDays(['2026-09-05'], NOW_LOCAL), 0);   // 陣列不是 Set
  assert.equal(streakFromDays(new Set(['壞掉的日期']), NOW_LOCAL), 0);
});

test('streakFromDays：跨月也要算得對', () => {
  // 3 月 1 日往回算會踩到 2 月的天數 —— 交給 Date 自己處理
  const base = new Date(2026, 2, 1, 12, 0, 0);
  const days = new Set([
    dayKey(base),
    dayKey(new Date(2026, 1, 28, 12, 0, 0)),
    dayKey(new Date(2026, 1, 27, 12, 0, 0)),
  ]);
  assert.equal(streakFromDays(days, base.getTime()), 3);
});


// ─── 一組練習的總結 ──────────────────────────────────────────────────────

const withIssues = (score, issues) => ({
  score,
  at: new Date(NOW_LOCAL).toISOString(),
  problemWords: issues.map(([issue, word]) => ({ word, issue, heard: '', tip_zh: '' })),
});

test('summariseSet：算出句數、平均、最高最低', () => {
  const summary = summariseSet([withIssues(60, []), withIssues(80, []), withIssues(70, [])]);
  assert.equal(summary.count, 3);
  assert.equal(summary.average, 70);
  assert.equal(summary.best, 80);
  assert.equal(summary.worst, 60);
});

test('summariseSet：重複出現的錯誤類型會被統計並排序', () => {
  // 「五句裡有三句都是 th」才是可以拿去練的結論
  const summary = summariseSet([
    withIssues(60, [['th', 'thoroughly'], ['r_l', 'really']]),
    withIssues(70, [['th', 'think']]),
    withIssues(80, [['th', 'three']]),
  ]);

  assert.equal(summary.issues[0].issue, 'th');
  assert.equal(summary.issues[0].count, 3);
  assert.deepEqual(summary.issues[0].words, ['thoroughly', 'think', 'three']);
  assert.equal(summary.issues[1].issue, 'r_l');
});

test('summariseSet：同一個字重複被點名時不會列兩次', () => {
  const summary = summariseSet([
    withIssues(60, [['th', 'think']]),
    withIssues(60, [['th', 'think']]),
  ]);
  assert.equal(summary.issues[0].count, 2);
  assert.deepEqual(summary.issues[0].words, ['think']);
});

test('summariseSet：舊格式（純字串）的紀錄不會讓統計壞掉', () => {
  const summary = summariseSet([
    { score: 60, problemWords: ['thoroughly'] },
    { score: 80, problemWords: [{ word: 'think', issue: 'th' }] },
  ]);
  // 字串沒有類型可以統計，跳過就好，不要因此丟掉整組
  assert.equal(summary.count, 2);
  assert.equal(summary.issues.length, 1);
});

test('summariseSet：空的或壞掉的輸入回一份空總結', () => {
  for (const input of [[], undefined, [{ score: 'x' }], [null]]) {
    const summary = summariseSet(input);
    assert.equal(summary.count, 0);
    assert.equal(summary.average, null);
    assert.deepEqual(summary.issues, []);
  }
});

// ─── 依弱點音抽句 ────────────────────────────────────────────────────────

const withProblems = (issues, minutesAgo = 0) => ({
  ...rec('x', 60, minutesAgo),
  problemWords: issues.map((issue) => ({ word: 'w', issue, heard: '', tip_zh: '' })),
});

test('weakIssues：統計最近的紀錄裡哪些音出問題出得最多', () => {
  const weak = weakIssues([
    withProblems(['th', 'r_l']),
    withProblems(['th'], 10),
    withProblems(['th'], 20),
  ]);
  assert.equal(weak.get('th'), 3);
  assert.equal(weak.get('r_l'), 1);
});

test('weakIssues：只看最近 N 筆，太舊的問題不再影響抽句', () => {
  // 一年前改掉的問題不該一直綁住現在的練習
  const history = [
    ...Array.from({ length: WEAK_WINDOW }, (_, i) => withProblems(['r_l'], i)),
    withProblems(['th'], WEAK_WINDOW + 1),
  ];
  const weak = weakIssues(history);
  assert.equal(weak.get('r_l'), WEAK_WINDOW);
  assert.equal(weak.has('th'), false);
});

test('weakIssues：舊格式（純字串）與壞資料不會讓統計爆掉', () => {
  const weak = weakIssues([
    { problemWords: ['thoroughly'] },
    { problemWords: [null, 42, { word: 'x' }] }, // 沒有 issue
    null,
    { score: 60 },
  ]);
  assert.equal(weak.size, 0);
  assert.equal(weakIssues(undefined).size, 0);
});

test('focusBoost：命中弱點的句子權重變高，最多兩倍', () => {
  const weak = new Map([['th', 6], ['r_l', 2]]);

  const both = focusBoost({ focus: ['th', 'r_l'] }, weak);
  const onlyTh = focusBoost({ focus: ['th', 'stress'] }, weak);
  const unrelated = focusBoost({ focus: ['v_w'] }, weak);

  assert.equal(both, 2);
  assert.ok(onlyTh > unrelated && onlyTh < both, `${unrelated} < ${onlyTh} < ${both}`);
});

test('focusBoost：下限是 1 —— 練不到弱點的句子只是不被偏好，不會被排除', () => {
  // 跟前面兩條加權同一個原則。focus 是人工標的，本來就不會完美，
  // 全部只給弱點音的句子會讓練習變得很窄。
  const weak = new Map([['th', 10]]);
  assert.equal(focusBoost({ focus: ['v_w'] }, weak), 1);
  assert.equal(focusBoost({ focus: [] }, weak), 1);
  assert.equal(focusBoost({}, weak), 1); // 還沒標 focus 的句子
  assert.equal(focusBoost(null, weak), 1);
});

test('focusBoost：沒有弱點資料時一律 1（新使用者不會被亂加權）', () => {
  assert.equal(focusBoost({ focus: ['th'] }, new Map()), 1);
  assert.equal(focusBoost({ focus: ['th'] }, null), 1);
});

test('matchedWeakIssues：只回「這句練得到、而且使用者確實有問題」的音', () => {
  const weak = new Map([['th', 2], ['r_l', 5]]);
  assert.deepEqual(matchedWeakIssues({ focus: ['th', 'v_w', 'r_l'] }, weak), ['r_l', 'th']);
  assert.deepEqual(matchedWeakIssues({ focus: ['v_w'] }, weak), []);
  assert.deepEqual(matchedWeakIssues({ focus: ['th'] }, new Map()), []);
});

test('pickSentence：練得到弱點音的句子明顯比較常被抽到', () => {
  const pool = [
    { id: 'th1', focus: ['th'] },
    { id: 'th2', focus: ['th'] },
    { id: 'other', focus: ['v_w'] },
  ];
  const weak = new Map([['th', 8]]);

  const counts = { th1: 0, th2: 0, other: 0 };
  for (let i = 0; i < 3000; i += 1) counts[pickSentence(pool, { weak, now: NOW }).id] += 1;

  // 權重 2 : 2 : 1 → 練得到 th 的兩句合計應該遠多於另一句
  assert.ok(counts.th1 + counts.th2 > counts.other * 3, JSON.stringify(counts));
  assert.ok(counts.other > 200, `練不到弱點的句子還是要抽得到：${counts.other} / 3000`);
});

test('pickSentence：沒傳 weak 時行為跟以前一樣（關掉加權的路徑）', () => {
  const pool = [
    { id: 'a', focus: ['th'] },
    { id: 'b', focus: ['v_w'] },
  ];
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 2000; i += 1) counts[pickSentence(pool, { now: NOW }).id] += 1;
  assert.ok(counts.a > 800 && counts.b > 800, `應該接近等機率：${JSON.stringify(counts)}`);
});
