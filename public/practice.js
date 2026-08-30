// 練習紀錄的分析與抽句邏輯。
//
// 這裡刻意只放**純函式**（不碰 DOM、不碰 localStorage），有兩個理由：
// 1. `npm test` 可以直接在 Node 裡 import 進來測，不需要瀏覽器；
// 2. 抽句的加權是會影響使用者體驗的規則，值得被回歸測試釘住 ——
//    權重調錯的症狀是「一直重複同幾句」，那種問題用眼睛看很難發現。

/** 趨勢圖預設顯示的筆數上限。再多點就擠在一起看不出走勢了。 */
export const TREND_LIMIT = 20;

/**
 * 依句子彙整練習紀錄。
 *
 * @param {Array<object>} history 由新到舊的紀錄（`storage.loadHistory()` 的格式）
 * @returns {Map<string, {count:number, average:number, last:number, lastAt:string}>}
 */
export function sentenceStats(history) {
  const stats = new Map();
  if (!Array.isArray(history)) return stats;

  // history 是由新到舊，所以第一次遇到某個 id 的那筆就是「最近一次」
  for (const record of history) {
    if (!record || typeof record.score !== 'number') continue;
    const id = record.sentenceId;
    if (id === undefined || id === null) continue;

    const found = stats.get(id);
    if (found) {
      found.count += 1;
      found.total += record.score;
    } else {
      stats.set(id, {
        count: 1,
        total: record.score,
        last: record.score,
        lastAt: record.at ?? '',
      });
    }
  }

  for (const stat of stats.values()) {
    stat.average = Math.round(stat.total / stat.count);
    delete stat.total;
  }
  return stats;
}

/**
 * 分數對應的基礎權重。分數越低權重越高，但不會高到把其他句子完全擠掉。
 *
 * 沒練過的句子給 3 —— 比「練過而且練得好」高（要鼓勵覆蓋沒碰過的句子），
 * 但比「練過而且練得爛」低（那些才是最該回頭練的）。
 *
 * | 狀態 | 基礎權重 |
 * |---|---|
 * | 沒練過 | 3 |
 * | 平均 100 分 | 1 |
 * | 平均 50 分 | 3 |
 * | 平均 0 分 | 5 |
 *
 * 最低是 1 而不是 0：練得好的句子只是變罕見，不會從池子裡消失，
 * 不然使用者會發現某些句子再也抽不到。
 */
export function scoreWeight(stat) {
  if (!stat || typeof stat.average !== 'number' || Number.isNaN(stat.average)) return 3;
  const weight = 1 + (100 - stat.average) / 25;
  return Math.min(5, Math.max(1, weight));
}

// ─── 間隔重複（spaced repetition）─────────────────────────────────────────
//
// 只看分數的話有個很明顯的破綻：**剛剛才練完的句子，下一秒還是最該練的那一句。**
// 分數低的句子權重高，練完那一輪分數通常也不會立刻變高，於是它又被抽中，
// 使用者會覺得「怎麼一直卡在同一句」。反過來，練得好的句子一旦沉下去就再也不回來，
// 但發音這種東西放兩個星期是會退的。
//
// 所以除了分數，再乘上一個「該不該複習了」的係數：剛練過的壓低、久沒練的回升。
// 這是 Anki／SuperMemo 那一系的簡化版 —— 沒有 ease factor、沒有評分等級，
// 因為這裡每次練習本來就會拿到一個 0～100 的分數，直接拿它決定下次該隔多久就夠了。

/** 平均 50 分的句子的複習間隔。其他分數以它為基準往上下推。 */
export const SRS_BASE_HOURS = 24;

/** 剛練完當下的係數。不是 0 —— 同一輪裡想再練一次那句，也不該完全抽不到。 */
export const DUE_MIN = 0.25;

/** 拖很久沒練的上限。再高會蓋過分數本身的差距，變成「只看多久沒練」。 */
export const DUE_MAX = 2;

/**
 * 這句下次該隔多久再練（小時）。
 *
 * 每差 25 分間隔就差一倍：0 分 6 小時、50 分 24 小時、100 分 96 小時。
 * 用指數而不是線性，是因為「練得好」與「練得爛」該有數量級的差距 ——
 * 差兩倍的話，練到 90 分的句子隔天照樣會一直冒出來。
 */
export function reviewIntervalHours(average) {
  const clamped = Math.min(100, Math.max(0, typeof average === 'number' ? average : 50));
  return SRS_BASE_HOURS * 2 ** ((clamped - 50) / 25);
}

/**
 * 「該複習了」的係數：剛練完 0.25，到了該複習的時間點約 1.1，拖很久趨近 2。
 *
 * 沒練過、或紀錄裡的時間壞掉（localStorage 是使用者改得動的）都當作 1 ——
 * 也就是「完全該練」，不要因為一個爛掉的時間字串就讓某句永遠抽不到。
 */
export function dueFactor(stat, now = Date.now()) {
  if (!stat) return 1;
  const last = Date.parse(stat.lastAt ?? '');
  if (Number.isNaN(last)) return 1;

  const elapsedHours = Math.max(0, (now - last) / 3_600_000);
  const ratio = elapsedHours / reviewIntervalHours(stat.average);
  // 1 - e^-x：一開始爬得快（剛練完的壓抑很快就鬆開），之後平緩地趨近上限
  return DUE_MIN + (DUE_MAX - DUE_MIN) * (1 - Math.exp(-ratio));
}

/**
 * 一個句子被抽中的權重 = 分數權重 × 該複習了沒。
 *
 * 兩者相乘的效果（以沒練過的 3 當基準）：
 *
 * | 狀態 | 權重 |
 * |---|---|
 * | 昨天練的，平均 0 分 | 約 9.8 |
 * | 沒練過 | 3 |
 * | 剛剛練完，平均 0 分 | 約 1.25 |
 * | 昨天練的，平均 100 分 | 約 0.6 |
 * | 剛剛練完，平均 100 分 | 0.25 |
 *
 * 最低仍然不是 0 —— 這條規則比加權本身更重要，`test/practice.test.js` 有測試釘住。
 */
export function sentenceWeight(stat, now = Date.now()) {
  return scoreWeight(stat) * dueFactor(stat, now);
}

/**
 * 這句是不是已經到了該複習的時間。只用來在畫面上說明，不影響抽句
 * （抽句是連續的權重，不是「到期／沒到期」的二分法）。
 */
export function isDue(stat, now = Date.now()) {
  if (!stat) return true;
  const last = Date.parse(stat.lastAt ?? '');
  if (Number.isNaN(last)) return true;
  return (now - last) / 3_600_000 >= reviewIntervalHours(stat.average);
}

/**
 * 從池子裡挑一句。
 *
 * @param {Array<object>} pool 候選句子
 * @param {object} [options]
 * @param {Map} [options.stats] `sentenceStats()` 的結果；沒給就等於全部沒練過
 * @param {boolean} [options.weighted] false 就退回等機率隨機
 * @param {*} [options.excludeId] 上一句的 id，池子多於一句時避免連續抽到同一句
 * @param {() => number} [options.random] 注入亂數來源，測試用
 * @param {number} [options.now] 現在時間（毫秒），間隔重複用；注入是為了測試
 * @returns {object|null}
 */
export function pickSentence(pool, options = {}) {
  const {
    stats = new Map(),
    weighted = true,
    excludeId = null,
    random = Math.random,
    now = Date.now(),
  } = options;

  if (!Array.isArray(pool) || pool.length === 0) return null;

  // 池子只剩一句時就只能重複，這時不排除
  const candidates =
    pool.length > 1 && excludeId !== null && excludeId !== undefined
      ? pool.filter((s) => s.id !== excludeId)
      : pool;
  const list = candidates.length > 0 ? candidates : pool;

  const pickAt = (index) => list[Math.min(list.length - 1, Math.max(0, index))];

  if (!weighted) return pickAt(Math.floor(random() * list.length));

  const weights = list.map((s) => sentenceWeight(stats.get(s.id), now));
  const total = weights.reduce((sum, w) => sum + w, 0);
  let threshold = random() * total;
  for (let i = 0; i < list.length; i += 1) {
    threshold -= weights[i];
    if (threshold < 0) return list[i];
  }
  // 浮點誤差讓迴圈跑完卻沒選到時的保底
  return list[list.length - 1];
}

/**
 * 趨勢圖的資料點：由舊到新（畫圖是往右長的），只取最近 `limit` 筆有分數的紀錄。
 *
 * @param {Array<object>} history 由新到舊
 * @returns {Array<{at:string, score:number, sentenceText:string}>} 由舊到新
 */
export function trendPoints(history, limit = TREND_LIMIT) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((r) => r && typeof r.score === 'number')
    .slice(0, limit)
    .reverse()
    .map((r) => ({
      at: r.at ?? '',
      score: r.score,
      sentenceText: r.sentenceText ?? '',
    }));
}
