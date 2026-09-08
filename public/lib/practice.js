// 練習紀錄的分析與抽句邏輯。
//
// 這裡刻意只放**純函式**（不碰 DOM、不碰 localStorage），有兩個理由：
// 1. `npm test` 可以直接在 Node 裡 import 進來測，不需要瀏覽器；
// 2. 抽句的加權是會影響使用者體驗的規則，值得被回歸測試釘住 ——
//    權重調錯的症狀是「一直重複同幾句」，那種問題用眼睛看很難發現。

/**
 * 把紀錄裡的時間欄位轉成毫秒。
 *
 * 舊版的練習紀錄把 `at` 存成 `Date.now()` 的數字，新版存 ISO 字串 ——
 * `Date.parse(1234567)` 會回 NaN，那會讓那一筆被當成「時間壞掉」而失去
 * 間隔重複的效果。使用者瀏覽器裡的舊資料不該因為我們換了格式就失效。
 *
 * @returns {number} 無法解析時回 NaN
 */
export function toTime(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  return Date.parse(value ?? '');
}

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
  const last = toTime(stat.lastAt);
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
  const last = toTime(stat.lastAt);
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
 * @param {Map<string, number>} [options.weak] `weakIssues()` 的結果，依弱點音加權用
 * @returns {object|null}
 */
export function pickSentence(pool, options = {}) {
  const {
    stats = new Map(),
    weighted = true,
    excludeId = null,
    random = Math.random,
    now = Date.now(),
    weak = null,
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

  const weights = list.map((s) => sentenceWeight(stats.get(s.id), now) * focusBoost(s, weak));
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
/**
 * 把一題的選項洗牌，並把正解的索引跟著換過去。
 *
 * **為什麼一定要有**：聽力題的選項是照著資料的順序畫出來的，而題庫裡
 * 366 題有 68% 的正解都在第二個位置（作者寫題目時會不自覺地把答案放第二個 ——
 * 這批新寫的 48 組自己也是 59%）。也就是說**一路按 B 就能對三分之二**，
 * 那就不是在練聽力了。單字卡沒有這個問題（`quiz.js` 出題時就洗過）。
 *
 * 在「拿到這一組題目的時候」洗，不是每次 render 都洗 —— 不然選項會在
 * 使用者要按下去的那一刻自己跳位。
 *
 * 純函式（`random` 可注入），不改動傳進來的那一題。
 *
 * @param {{options: string[], answer: number}} question
 * @param {() => number} [random]
 * @returns {object} 洗過的新物件，`answer` 指向洗牌後正解的位置
 */
export function shuffleOptions(question, random = Math.random) {
  const options = question?.options;
  if (!Array.isArray(options) || options.length < 2) return question;

  // 連著正解一起搬，才不會出現「洗完之後 answer 指到別的選項」——
  // 那種錯的症狀是「明明選對卻說錯」，而且只有部分題目會這樣
  const pairs = options.map((text, i) => ({ text, correct: i === question.answer }));

  // Fisher-Yates。用 for 迴圈而不是 sort(() => random() - 0.5)：
  // 那種寫法的分佈是歪的（而且各家 sort 的實作不同，歪法還不一樣）
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }

  const answer = pairs.findIndex((p) => p.correct);
  return {
    ...question,
    options: pairs.map((p) => p.text),
    // 原本的 answer 壞掉（超出範圍）時 findIndex 會回 -1 —— 那就維持原值，
    // 不要把它變成 -1 而讓「對答案」永遠說你錯
    answer: answer >= 0 ? answer : question.answer,
  };
}

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

// ─── 每日目標與連續天數（階段 7）────────────────────────────────────────
//
// 為什麼要有這個：練習紀錄回答的是「我練得怎麼樣」，但**沒有回答「我今天練了嗎」**。
// 各大英語學習 App 都有的 streak／每日目標解的就是這件事 ——
// 它不是遊戲化的裝飾，而是把「每天回來」這個行為本身變成看得見的東西。
//
// 一律用**本地時間**切一天。使用者說的「昨天」是他自己時區的昨天，
// 用 UTC 切的話，台灣時間晚上八點以後練的都會被算成隔天。

/** 一筆紀錄屬於哪一天（本地時間的 YYYY-MM-DD）。時間壞掉回空字串。 */
export function dayKey(value) {
  const date = value instanceof Date ? value : new Date(toTime(value));
  if (Number.isNaN(date.getTime())) return '';
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** 往前／往後推 n 天的 dayKey。跨月、跨年、日光節約都交給 Date 自己算。 */
function shiftDay(base, days) {
  const date = new Date(base);
  date.setDate(date.getDate() + days);
  return dayKey(date);
}

/**
 * 連續練習天數。吃的是一組 dayKey（`lib/storage.js` 的計數表整理出來的）。
 *
 * **今天還沒練不會馬上歸零** —— 從昨天開始往回算。
 * 這是刻意的：早上打開 App 看到「連續 0 天」，會讓人覺得昨天的努力已經沒了，
 * 那正好是最不該讓人放棄的時間點。真的斷了（前天以前才練過）才是 0。
 *
 * 六個模式共用這一份 —— 各寫各的話，跨月、日光節約這些邊界會各錯各的。
 */
export function streakFromDays(days, now = Date.now()) {
  if (!(days instanceof Set) || days.size === 0) return 0;

  const today = dayKey(new Date(now));
  // 今天練過就從今天算，沒練過就從昨天算；昨天也沒有才是真的斷了
  let cursor = days.has(today) ? today : shiftDay(new Date(now), -1);
  if (!days.has(cursor)) return 0;

  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = shiftDay(new Date(`${cursor}T12:00:00`), -1); // 中午避開日光節約的邊界
  }
  return streak;
}

// ─── 一組練習（階段 7）──────────────────────────────────────────────────
//
// 「換一句、再換一句」是沒有終點的，練到什麼時候算一段落全靠使用者自己決定 ——
// 結果就是很容易練兩句就關掉。切成一組 5 句，是為了讓每一次打開 App 都有個
// 看得到的終點，以及一份「這一組練得怎麼樣」的總結。

/** 一組幾句。5 句約 3～5 分鐘，短到隨時可以開始，長到看得出平均分有意義。 */
export const SET_SIZE = 5;

/**
 * 一組練完之後的總結。
 *
 * 重點是 `issues`：一組裡重複出現的錯誤類型，比單看某一句的分數有用得多 ——
 * 「五句裡有三句都是 th」是一個可以拿去練的結論，「平均 72 分」不是。
 *
 * @param {Array<object>} records 這一組的紀錄（由舊到新）
 */
export function summariseSet(records) {
  const list = Array.isArray(records) ? records.filter((r) => typeof r?.score === 'number') : [];
  if (list.length === 0) return { count: 0, average: null, best: null, worst: null, issues: [] };

  const scores = list.map((r) => r.score);
  const counts = new Map();

  for (const record of list) {
    const words = Array.isArray(record.problemWords) ? record.problemWords : [];
    for (const item of words) {
      // 舊紀錄是純字串，沒有類型可以統計
      if (!item || typeof item !== 'object' || !item.issue) continue;
      const found = counts.get(item.issue);
      if (found) {
        found.count += 1;
        if (!found.words.includes(item.word)) found.words.push(item.word);
      } else {
        counts.set(item.issue, { issue: item.issue, count: 1, words: [item.word] });
      }
    }
  }

  return {
    count: list.length,
    average: Math.round(scores.reduce((a, b) => a + b, 0) / list.length),
    best: Math.max(...scores),
    worst: Math.min(...scores),
    // 次數多的排前面；一樣多時照第一次出現的順序，才不會每次重畫都跳動
    issues: [...counts.values()].sort((a, b) => b.count - a.count),
  };
}

// ─── 依弱點音抽句（階段 8）──────────────────────────────────────────────
//
// 階段 7 的總結會告訴你「這一組有三句都是 th」，但下一組不會因此多給你 th 的句子 ——
// 講完就沒有下文，跟階段 6 之前的練習紀錄一樣。
//
// 所以 `sentences.json` 的每一句多了 `focus`（這句在練哪些音），
// 抽句時再乘上一個「這句練不練得到你的弱點」的係數。
// ELSA 那類 App 的做法也是這樣：分析出你哪個音有問題，然後餵你那個音的題目。

/** 只看最近這麼多筆紀錄。太舊的問題可能早就改掉了，一直拿來加權只會綁住使用者。 */
export const WEAK_WINDOW = 30;

/** 完全命中弱點時的最大加成。1 代表最多兩倍。 */
export const FOCUS_BONUS = 1;

/**
 * 最近的紀錄裡，哪些音出問題出得最多。
 *
 * @param {Array<object>} history 由新到舊
 * @returns {Map<string, number>} issue 代碼 → 出現次數
 */
export function weakIssues(history, limit = WEAK_WINDOW) {
  const counts = new Map();
  if (!Array.isArray(history)) return counts;

  for (const record of history.slice(0, limit)) {
    const words = Array.isArray(record?.problemWords) ? record.problemWords : [];
    for (const item of words) {
      // 舊紀錄是純字串，沒有類型可以統計
      if (!item || typeof item !== 'object' || !item.issue) continue;
      counts.set(item.issue, (counts.get(item.issue) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * 這句練不練得到你的弱點：1（完全沒關係）～ 2（把你的問題全包了）。
 *
 * **下限是 1，不是 0** —— 跟前面兩條加權同一個原則：
 * 沒標 `focus` 的句子、練不到你弱點的句子，只是不會被特別偏好，不會被排除。
 * 全部只給弱點音的句子會讓練習變得很窄，而且 `focus` 是人工標的，本來就不會完美。
 */
export function focusBoost(sentence, weak) {
  if (!weak || weak.size === 0) return 1;
  const focus = Array.isArray(sentence?.focus) ? sentence.focus : [];
  if (focus.length === 0) return 1;

  let total = 0;
  for (const count of weak.values()) total += count;
  if (total === 0) return 1;

  // 同一句可能標了兩個音，兩個都命中就加得比較多，但整體仍封頂在 2 倍
  const matched = focus.reduce((sum, tag) => sum + (weak.get(tag) ?? 0), 0);
  return 1 + FOCUS_BONUS * Math.min(1, matched / total);
}

/**
 * 一句話說明「為什麼會抽到這句」裡跟弱點有關的那一部分。
 *
 * @returns {string[]} 這句練得到、而且使用者確實有問題的音（照問題多寡排序）
 */
export function matchedWeakIssues(sentence, weak) {
  if (!weak || weak.size === 0) return [];
  const focus = Array.isArray(sentence?.focus) ? sentence.focus : [];
  return focus
    .filter((tag) => (weak.get(tag) ?? 0) > 0)
    .sort((a, b) => weak.get(b) - weak.get(a));
}
