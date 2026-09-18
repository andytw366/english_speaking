// 「今天這個模式練完了」的那張總結。五個模式共用。
//
// ─── 為什麼要擋在動線上 ──────────────────────────────────────────────────
//
// 跟讀的「一組練完」原本畫在講評下面的第四張卡 —— 而那個位置在整頁的最下面，
// 使用者根本不會捲到那裡，所以那張總結一次也沒被看到過。改成按「換一句」時
// **先停在總結**才有人看（見 `modes/shadowing.js` 的 `onNextSentence()`）。
//
// 這一張是同一個道理，只是尺度換成一天：達到今天的目標的那一刻把主欄換掉。
// 那是使用者本來就會停下來的那一刻 —— 他剛答完最後一題，正在想「還要再練嗎」。
//
// ─── 鼓勵的寫法 ──────────────────────────────────────────────────────────
//
// **只講事實，不用罰的。** 這條規矩從 `today-card.js` 的 `todayNote()` 就開始了
// （刻意不寫「你今天還沒練，連續天數要斷了」）。這裡往前再一步：鼓勵是
// **具體的數字**，不是形容詞。
//
//   ✅「今天 8 個新字，是最近七天最多的一天。」
//   ❌「太棒了！你真是太厲害了！繼續加油！」
//
// 第二種講了等於沒講，而且每天都一樣 —— 看三次就變成一個要按掉的東西。
// 第一種每天不一樣，因為它是從今天真的發生的事算出來的。

import { h, append } from './dom.js';
import { statTile } from './stat-tile.js';
import { dailyState } from './daily.js';
import { modeMeta } from './modes.js';
import { dayKey, weakIssues } from './practice.js';
import { issueLabel } from './labels.js';
import {
  getResults, getSrsState, getHistory, sumResults, resultDays,
  markSummarySeen, summarySeenToday, RESULT_FIELDS,
} from './storage.js';
import { computeAbility, topWeaknesses } from './ability.js';

export { markSummarySeen, summarySeenToday };

/** 「跟最近比」拿幾天當基準。不含今天。 */
const COMPARE_DAYS = 7;

/**
 * 現在該不該把總結擋出來。
 *
 * 三個條件都要成立：有設目標、今天達標了、今天還沒看過這個模式的總結。
 * 沒設目標的模式不會有總結 —— 「練完了」需要有一條線才講得出來。
 */
export function dueForSummary(mode, now = Date.now()) {
  const { goal, done } = dailyState(mode, now);
  return goal > 0 && done >= goal && !summarySeenToday(mode, now);
}

/**
 * 今天這個模式的成績。純函式的部分在 `summariseDay()`，這裡是它加上 localStorage。
 */
export function todaySummary(mode, now = Date.now()) {
  return summariseDay({
    mode,
    results: getResults(),
    state: dailyState(mode, now),
    history: mode === 'shadowing' ? getHistory() : [],
    now,
  });
}

/**
 * 今天練得怎麼樣，以及跟最近比起來如何。**純函式** —— 資料從參數進來，測得到。
 *
 * @returns {{mode, state, today, past, rate, pastRate, average, pastAverage,
 *   issues: Array<{issue, count}>}}
 *   `rate` / `average` 在算不出來時是 null（今天一題都沒判定成功也是有可能的）
 */
export function summariseDay({ mode, results = {}, state, history = [], now = Date.now() }) {
  const fields = RESULT_FIELDS[mode] ?? [];
  const today = dayKey(new Date(now));

  // 基準是「最近幾個**有練的日子**」而不是「最近七個日曆天」——
  // 隔了一週才回來練，基準不該是六天的 0 加一天的成績
  const past = resultDays(results, mode).filter((d) => d !== today).slice(0, COMPARE_DAYS);

  const sumToday = sumResults(results, mode, [today]);
  const sumPast = sumResults(results, mode, past);

  return {
    mode,
    state,
    today: sumToday,
    past: sumPast,
    pastDays: past.length,
    fields,
    rate: passRate(mode, sumToday),
    pastRate: passRate(mode, sumPast),
    average: average(sumToday),
    pastAverage: average(sumPast),
    // 今天被點名最多的音（只有跟讀有）。history 由新到舊，先切出今天的
    issues: mode === 'shadowing' ? issuesOn(history, today) : [],
    // 今天的最高 / 最低（只有跟讀有）。**這張總結會把「一組練完」那張吃掉**
    // （跟讀的每日目標預設就是 5 句、一組也是 5 句，兩張會在同一刻一起出現），
    // 所以那張上面有的東西這裡都要有，不然合併等於弄丟資訊。
    ...scoreRange(mode === 'shadowing' ? history : [], today),
  };
}

/** 今天的最高 / 最低分。沒有有分數的紀錄就兩個都是 null。 */
function scoreRange(history, day) {
  const scores = (history ?? [])
    .filter((r) => dayKey(r?.at) === day && typeof r?.score === 'number')
    .map((r) => r.score);
  return scores.length
    ? { best: Math.max(...scores), worst: Math.min(...scores) }
    : { best: null, worst: null };
}

/** 正確率／通過率。聽力照題算，其餘照題／句算。跟讀沒有「對錯」，回 null。 */
function passRate(mode, sums) {
  if (mode === 'shadowing') return null;
  const whole = mode === 'listening' ? sums.q : sums.n;
  return whole > 0 ? Math.round((sums.ok / whole) * 100) : null;
}

/** 平均分（只有跟讀有）。`sum / n`，兩個都是單調的計數器（見 merge.js）。 */
function average(sums) {
  return sums.n > 0 && typeof sums.sum === 'number' ? Math.round(sums.sum / sums.n) : null;
}

function issuesOn(history, day) {
  const todayRecords = (history ?? []).filter((r) => dayKey(r?.at) === day);
  return [...weakIssues(todayRecords, todayRecords.length).entries()]
    .map(([issue, count]) => ({ issue, count }))
    .sort((a, b) => b.count - a.count);
}

// ─── 畫面 ────────────────────────────────────────────────────────────────

/**
 * 那張總結。
 *
 * @param {string} mode
 * @param {object} handlers
 * @param {() => void} handlers.onDismiss 主要按鈕：關掉總結回到練習
 * @param {string} [handlers.dismissLabel] 主要按鈕上的字（單字卡是「再多練 10 個」）
 * @param {Array<HTMLElement|null>} [handlers.actions] 這個模式自己要多加的按鈕
 * @param {(mode: string) => void} [handlers.onGoTo] 「去練別的」——切到另一個模式
 * @param {number} [handlers.now]
 */
export function renderDaySummary(mode, {
  onDismiss, dismissLabel = '', actions = [], onGoTo = switchTo, now = Date.now(),
} = {}) {
  const s = todaySummary(mode, now);
  const meta = modeMeta(mode);
  const unit = meta.unit ?? '個';

  const card = h('div', { class: 'card card--set card--daydone' },
    h('p', { class: 'card__title' }, `${meta.icon} 今天的${meta.label}練完了`),
    h('div', { class: 'stats' }, tilesFor(s, unit)),
    h('p', { class: 'daydone__note' }, encourage(s, unit)),
  );

  const detail = detailFor(s);
  if (detail) append(card, h('p', { class: 'hint' }, detail));

  // 下一步：**指向目前最弱的那個面向**，而不是「回首頁」。
  // 剛練完一個模式的人正在決定「還要不要練」，那一刻給他一個具體的去處，
  // 比給他一個還要再挑一次的清單有用。
  const next = nextStep(mode);
  append(card,
    h('div', { class: 'row' },
      h('button', { class: 'btn btn--primary', onclick: onDismiss },
        dismissLabel || `再多練幾${unit}`),
      next && h('button', {
        class: 'btn',
        onclick: () => { onDismiss?.(); onGoTo?.(next.mode); },
      }, `${next.icon} ${next.cta}`),
      ...actions,
    ),
    next && h('p', { class: 'hint' }, `${next.label}：${next.text}`),
  );

  return card;
}

/** 「答對」還是「通過」。單字卡有標準答案，其餘三個是「這樣說可以嗎」。 */
function passLabel(mode) {
  return mode === 'vocabulary' ? '答對' : '通過';
}

function tilesFor(s, unit) {
  const tiles = [
    statTile('今天練的', `${s.state.done} ${unit}`),
    statTile('連續天數', `${s.state.streak} 天`),
  ];

  if (s.mode === 'shadowing') {
    tiles.splice(1, 0, statTile('平均分數', s.average === null ? '—' : String(s.average)));
    if (s.best !== null) tiles.splice(2, 0, statTile('最高 / 最低', `${s.best} / ${s.worst}`));
  } else if (s.rate !== null) {
    // **只放比率，不另外放一個「14 / 20」的磚** —— 那是同一個事實的兩種寫法，
    // 而磚超過四個時手機上每個只剩 65px，中文標籤會斷在字與字之間。
    // 原始的分數寫在底下那行（`detailFor()`）
    tiles.splice(1, 0, statTile(`${passLabel(s.mode)}率`, `${s.rate}%`));
  }

  if (s.mode === 'vocabulary' && s.today.fresh > 0) {
    tiles.push(statTile('新字', `${s.today.fresh} 個`));
  }
  return tiles;
}

/**
 * 鼓勵的那一句。**每一句都是從今天真的發生的事算出來的**，
 * 所以它每天不一樣 —— 一句每天都一樣的話會在第三天變成噪音。
 *
 * 排序就是「哪一件事最值得講」：進步 > 超出目標 > 連續天數 > 只是講事實。
 */
export function encourage(s, unit = '個') {
  const { state } = s;
  const over = state.done - state.goal;

  // 1. 比最近好 —— 有基準可以比的時候，這是最有內容的一句
  if (s.rate !== null && s.pastRate !== null && s.pastDays >= 2 && s.rate > s.pastRate) {
    return `今天的正確率 ${s.rate}%，比前 ${s.pastDays} 天的 ${s.pastRate}% 高了 ${s.rate - s.pastRate} 個百分點。`;
  }
  if (s.average !== null && s.pastAverage !== null && s.pastDays >= 2 && s.average > s.pastAverage) {
    return `今天平均 ${s.average} 分，比前 ${s.pastDays} 天的 ${s.pastAverage} 分高了 ${s.average - s.pastAverage} 分。`;
  }

  // 2. 超出今天的目標
  if (over > 0) return `今天的目標是 ${state.goal} ${unit}，你練了 ${state.done} ${unit}，多做了 ${over} ${unit}。`;

  // 3. 連續天數。**只在往上數，不講「會斷掉」**（見檔案開頭）
  if (state.streak > 1) return `連續第 ${state.streak} 天達成今天的目標。`;

  // 4. 沒有什麼特別的，就把事實講一次 —— 硬要找話講會變成客套
  return `今天的 ${state.goal} ${unit}練完了。`;
}

/** 數字底下那一行補充。沒有可講的就回空字串（寧可少一行，不要湊一句）。 */
function detailFor(s) {
  if (s.mode === 'vocabulary') {
    const wrong = s.today.n - s.today.ok;
    const parts = [`答對 ${s.today.ok} / ${s.today.n} 張`];
    if (s.today.fresh > 0) parts.push(`${s.today.fresh} 個新字現在在第 1 盒，明天會再出現一次`);
    if (wrong > 0) parts.push(`答錯的 ${wrong} 個字退了一盒，會排在下一輪的最前面`);
    return `${parts.join('；')}。`;
  }
  if (s.mode === 'shadowing' && s.issues.length > 0) {
    const top = s.issues.slice(0, 2)
      .map((i) => `${issueLabel(i.issue)}（${i.count} 次）`).join('、');
    return `今天被點名最多的是 ${top}。接下來會多抽一些練得到這些音的句子。`;
  }
  if (s.mode === 'translation' || s.mode === 'dialogue') {
    const whole = s.today.n;
    const head = `通過 ${s.today.ok} / ${whole} ${s.mode === 'translation' ? '題' : '句'}`;
    return s.today.aiN > 0
      ? `${head}；其中 ${s.today.aiN} 次是 AI 判的 —— 能力量表上的「表達」優先採用這一種判定。`
      : `${head}。`;
  }
  if (s.mode === 'listening' && s.rate !== null) {
    return `答對 ${s.today.ok} / ${s.today.q} 題（今天的份算的是「組」，正確率算的是「題」）。`;
  }
  return '';
}

/**
 * 切到別的模式。用事件而不是直接呼叫 `app.js` 的 `switchTo()`：
 * 模式模組是被 `app.js` 動態 import 的，反過來 import 它會變成循環相依
 * （首頁的 `goTo()` 是同一件事、同一個理由）。
 */
export function switchTo(id) {
  window.dispatchEvent(new CustomEvent('switch-mode', { detail: id }));
}

/**
 * 接下來去哪。取最該練的那一項，**但排掉剛練完的這個模式** ——
 * 剛達標的模式就算仍然是最弱的一項，此刻叫他再去練同一個也沒有意義。
 */
function nextStep(mode) {
  const dims = computeAbility({ results: getResults(), srsState: getSrsState() });
  const list = topWeaknesses(dims, {
    weak: weakIssues(getHistory()),
    issueLabel,
    limit: 4,
  });
  return list.find((w) => w.mode !== mode) ?? null;
}
