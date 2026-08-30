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
 * 一個句子被抽中的權重。分數越低權重越高，但不會高到把其他句子完全擠掉。
 *
 * 沒練過的句子給 3 —— 比「練過而且練得好」高（要鼓勵覆蓋沒碰過的句子），
 * 但比「練過而且練得爛」低（那些才是最該回頭練的）。
 *
 * | 狀態 | 權重 |
 * |---|---|
 * | 沒練過 | 3 |
 * | 平均 100 分 | 1 |
 * | 平均 50 分 | 3 |
 * | 平均 0 分 | 5 |
 *
 * 最低是 1 而不是 0：練得好的句子只是變罕見，不會從池子裡消失，
 * 不然使用者會發現某些句子再也抽不到。
 */
export function sentenceWeight(stat) {
  if (!stat || typeof stat.average !== 'number') return 3;
  const weight = 1 + (100 - stat.average) / 25;
  return Math.min(5, Math.max(1, weight));
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
 * @returns {object|null}
 */
export function pickSentence(pool, options = {}) {
  const {
    stats = new Map(),
    weighted = true,
    excludeId = null,
    random = Math.random,
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

  const weights = list.map((s) => sentenceWeight(stats.get(s.id)));
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
