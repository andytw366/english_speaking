// 四個能力面向，以及「現在最該練什麼」。
//
// ─── 為什麼是四個面向而不是五個模式 ──────────────────────────────────────
//
// 中翻英與情境對話考的是同一件事：**能不能把想講的意思用英文說出來**。
// 一個是用寫的、一個是在對話裡，但「這句話說得通嗎」的判定是同一套
// （`lib/verdict.js` 兩個模式共用）。分成兩軸的話，同一種能力會在圖上佔兩格，
// 看起來像是它比聽力重要兩倍。
//
// ─── 四個軸的單位不一樣，這件事沒有被藏起來 ──────────────────────────────
//
// 聽得懂 / 表達 / 唸得準 是**比率或分數**（正確率、平均分），字彙是**狀態**
// （練過的字現在平均在第幾盒）。硬要湊成同一個單位是做不到的，所以：
//
//   - 圖上四條都是 0～100 的「熟不熟」，**只講質不講量**；
//   - 「練過幾個字、已熟練幾個」這種量的數字用文字寫在旁邊。
//
// 只看圖的話，練熟 5 個字的人字彙軸會是滿的 —— 那不是 bug，是這張圖本來就
// 不回答「你會幾個字」。旁邊那行字才回答。
//
// ─── 沒有資料要畫成「還沒練過」，不是 0 ──────────────────────────────────
//
// 0 分的意思是「練了，很差」；沒練過的模式畫成 0 等於對著沒碰過那一項的人說
// 「你這裡是 0 分」。所以樣本不夠時 `score` 是 **null**，畫面要另外處理。

import { BOX_COUNT } from './storage.js';
import { modeMeta } from './modes.js';

/**
 * 最近幾個**有練的日子**算一次能力（不是最近幾個日曆天）。
 *
 * 用「有練的日子」而不是「日曆天」：出差一週沒打開，回來時能力圖不該變成
 * 一片「還沒有資料」—— 那幾天沒有新資訊，不是舊資訊失效了。
 */
export const WINDOW_DAYS = 14;

/**
 * 樣本少於這個數就不給分（`score: null`）。
 *
 * 門檻是「一個數字開始有意義的最小量」：3 題答對 2 題算 67% 沒有任何意義，
 * 而畫出來的那一格會讓人真的去相信它。跟讀的門檻低一些 ——
 * 它的每一次是 0～100 的連續分數，不是對錯，三次就看得出大概落在哪。
 */
export const MIN_SAMPLE = { vocab: 10, listen: 10, express: 10, pronounce: 3 };

/** 四個面向。`modes` 是點進去要去哪個分頁（第一個是主要的那個）。 */
export const DIMENSIONS = [
  { id: 'vocab', label: '字彙', icon: '🗂️', modes: ['vocabulary'] },
  { id: 'listen', label: '聽得懂', icon: '🎧', modes: ['listening'] },
  { id: 'express', label: '表達', icon: '✍️', modes: ['translation', 'dialogue'] },
  { id: 'pronounce', label: '唸得準', icon: '🗣️', modes: ['shadowing'] },
];

/** 這個分數算「還可以」了。低於它才會被排進「現在最該練什麼」。 */
export const OK_SCORE = 80;

function pct(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

function clamp100(n) {
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * 最近有練的那幾天。由新到舊，最多 `WINDOW_DAYS` 天。
 *
 * @param {object} results `getResults()` 的結果
 * @param {string[]} modes 這幾個模式任何一個有練就算一天
 */
export function recentDays(results, modes, limit = WINDOW_DAYS) {
  const days = new Set();
  for (const mode of modes) {
    for (const day of Object.keys(results?.[mode] ?? {})) days.add(day);
  }
  return [...days].sort().reverse().slice(0, limit);
}

/**
 * 四個面向現在各是幾分。**純函式** —— 資料全部從參數進來。
 *
 * @param {object} input
 * @param {object} input.results  每日成績表（`getResults()`）
 * @param {object} input.srsState 複習進度（`getSrsState()`）
 * @param {number} [input.now]
 * @returns {Array<{id, label, icon, modes, score: number|null, sample: number,
 *   detail: string, note: string}>}
 *   `score` null = 樣本不夠，畫面要顯示「還沒練過」而不是 0
 *   `detail` 是量（幾個字、幾題），`note` 是質的來源（哪一段期間、誰判的）
 */
export function computeAbility({ results = {}, srsState = {}, now = Date.now() } = {}) {
  return [
    vocabDimension(srsState, now),
    listenDimension(results),
    expressDimension(results),
    pronounceDimension(results),
  ];
}

function meta(id) {
  return DIMENSIONS.find((d) => d.id === id);
}

/**
 * 字彙：**練過的字現在平均在第幾盒**，換算成 0～100。
 *
 * 全部在第 1 盒 = 0（剛發下去、還沒答對過），全部第 6 盒 = 100（已熟練）。
 * 不用「已熟練的比例」是因為第 6 盒要爬兩個月，那條線會有兩個月完全不動 ——
 * 一個每天都在進步的人看到一條不動的線，只會以為這個功能壞了。
 *
 * 不碰任何字庫檔（首頁不載入 3 MB 的字庫，見 README）：盒號在 `srs` 裡就有。
 */
function vocabDimension(srsState, now) {
  const states = Object.values(srsState ?? {}).filter((s) => s && typeof s === 'object');
  const practised = states.length;
  const mastered = states.filter((s) => Number(s.box) >= BOX_COUNT).length;
  const due = states.filter((s) => (Number(s.due) || 0) <= now).length;
  const boxSum = states.reduce((sum, s) => sum + Math.min(BOX_COUNT, Math.max(1, Number(s.box) || 1)), 0);

  const enough = practised >= MIN_SAMPLE.vocab;
  return {
    ...meta('vocab'),
    score: enough ? clamp100(((boxSum / practised) - 1) / (BOX_COUNT - 1) * 100) : null,
    sample: practised,
    detail: practised ? `練過 ${practised} 個字・已熟練 ${mastered} 個` : '還沒練過字',
    // 樣本不夠時 note 要講「還差多少」而不是到期數 ——
    // 排行榜會把它接在「還沒有足夠的資料 ——」後面，接上到期數會變成另一句話
    note: !enough ? `再練 ${MIN_SAMPLE.vocab - practised} 個字就算得出來`
      : due > 0 ? `${due} 個到期了` : '沒有到期的字',
    extra: { practised, mastered, due },
  };
}

/** 聽得懂：最近那幾天的**題目**正確率（今天的份算「組」，正確率只有照題算才有意義）。 */
function listenDimension(results) {
  const days = recentDays(results, ['listening']);
  const { q, ok, n } = sumOver(results, 'listening', days, ['q', 'ok', 'n']);

  const enough = q >= MIN_SAMPLE.listen;
  return {
    ...meta('listen'),
    score: enough ? clamp100(pct(ok, q)) : null,
    sample: q,
    detail: q ? `最近 ${n} 組・${ok} / ${q} 題` : '還沒練過聽力',
    note: enough ? `最近 ${days.length} 天有練的日子` : `再練 ${MIN_SAMPLE.listen - q} 題就算得出來`,
    extra: { sets: n, questions: q, correct: ok },
  };
}

/**
 * 表達：中翻英與情境對話合起來的通過率。
 *
 * **模型看過的那部分優先**。本地判定是關鍵字比對，repo 自己承認它看不懂句子
 * （`lib/grade.js` 的註解），而且手寫的那批中翻英題有已知的 keywords 欠債
 * （會把題目自己列的另一種說法判成錯，見 TODO）。兩種判定混在一起平均，
 * 算出來的數字會同時受「你寫得好不好」與「這題的關鍵字挑得準不準」影響 ——
 * 而使用者只看得到前者的解釋。
 *
 * 模型判過的量不夠（關掉、或都沒按手動）才退回本地判定，並且在 `note` 裡說清楚。
 */
function expressDimension(results) {
  const days = recentDays(results, ['translation', 'dialogue']);
  const t = sumOver(results, 'translation', days, ['n', 'ok', 'aiN', 'aiOk']);
  const d = sumOver(results, 'dialogue', days, ['n', 'ok', 'aiN', 'aiOk']);

  const n = t.n + d.n;
  const ok = t.ok + d.ok;
  const aiN = t.aiN + d.aiN;
  const aiOk = t.aiOk + d.aiOk;

  const useAi = aiN >= MIN_SAMPLE.express;
  const sample = useAi ? aiN : n;
  const enough = sample >= MIN_SAMPLE.express;

  return {
    ...meta('express'),
    score: enough ? clamp100(pct(useAi ? aiOk : ok, sample)) : null,
    sample,
    detail: n ? `最近 ${t.n} 題中翻英・${d.n} 句對話` : '還沒練過中翻英或對話',
    note: !enough ? `再練 ${MIN_SAMPLE.express - sample} 題就算得出來`
      : useAi ? `AI 判過的 ${aiN} 題` : '關鍵字比對（AI 沒看過這些）',
    extra: { n, ok, aiN, aiOk, useAi },
  };
}

/** 唸得準：最近那幾天的平均分。`sum / n`，兩個都是單調的計數器（見 merge.js）。 */
function pronounceDimension(results) {
  const days = recentDays(results, ['shadowing']);
  const { n, sum } = sumOver(results, 'shadowing', days, ['n', 'sum']);

  const enough = n >= MIN_SAMPLE.pronounce;
  return {
    ...meta('pronounce'),
    score: enough ? clamp100(sum / n) : null,
    sample: n,
    detail: n ? `最近 ${n} 句` : '還沒練過跟讀',
    note: enough ? `最近 ${days.length} 天有練的日子` : `再練 ${MIN_SAMPLE.pronounce - n} 句就算得出來`,
    extra: { n, sum },
  };
}

/** 把一段日子裡的計數器加起來。`storage.js` 的 `sumResults()` 是同一件事，這裡是不碰儲存的版本。 */
function sumOver(results, mode, days, fields) {
  const out = Object.fromEntries(fields.map((f) => [f, 0]));
  const table = results?.[mode] ?? {};
  for (const day of days) {
    for (const cell of Object.values(table[day] ?? {})) {
      if (!cell || typeof cell !== 'object') continue;
      for (const field of fields) {
        const v = Number(cell[field]);
        if (Number.isFinite(v) && v > 0) out[field] += v;
      }
    }
  }
  return out;
}

// ─── 現在最該練什麼 ──────────────────────────────────────────────────────
//
// **這張排行榜才是回答「我目前的問題是什麼」的東西。** 雷達圖給的是一眼的高低，
// 而「聽力那一格比較短」不是一個可以拿去做的結論 ——「最近 20 題只對 11 題，
// 去練聽力」才是。所以每一條都要有：一個具體的數字、一個可以點下去的地方。
//
// 刻意**不放**「有 N 個字到期了」：首頁側欄的複習排程已經在講同一件事，
// 同一個畫面上兩個地方講同一句話，使用者會以為那是兩件不同的事。

/** 同一個問題音出現幾次才值得被單獨點名。一兩次是雜訊。 */
export const MIN_ISSUE_COUNT = 3;

/**
 * 排出最該處理的幾件事。**純函式**。
 *
 * @param {Array<object>} dims `computeAbility()` 的結果
 * @param {object} options
 * @param {Map<string, number>} [options.weak] `practice.js` 的 `weakIssues()`：問題音 → 次數
 * @param {(code:string)=>string} [options.issueLabel] 問題音的中文（避免這裡 import 畫面用的字串）
 * @param {number} [options.limit]
 * @returns {Array<{id, icon, label, text, mode, cta}>}
 *   `mode` 是點下去要去哪個分頁，`cta` 是那顆按鈕上的字
 */
export function topWeaknesses(dims, { weak = null, issueLabel = (c) => c, limit = 3 } = {}) {
  const list = Array.isArray(dims) ? dims : [];
  const top = topIssue(weak);
  const out = [];

  // 1. 有分數而且分數不夠好的，由低到高
  const low = list
    .filter((d) => typeof d.score === 'number' && d.score < OK_SCORE)
    .sort((a, b) => a.score - b.score);

  const lowest = low[0]?.id;
  for (const dim of low) {
    // 唸得準底下**順便把問題音講掉**：那是同一件事的細節，
    // 拆成兩條的話畫面上會有兩條都在講發音，而使用者只有一個發音問題
    const detail = dim.id === 'pronounce' && top
      ? `最常被點名的是 ${issueLabel(top.issue)}（${top.count} 次）`
      : dim.detail;
    out.push({
      id: dim.id,
      icon: dim.icon,
      label: dim.label,
      text: `${dim.score} 分・${detail}` + (dim.id === lowest && low.length > 1 ? '，四個面向裡最低' : ''),
      mode: dim.modes[0],
      cta: ctaFor(dim.modes[0]),
    });
  }

  // 2. 唸得準本身還可以，但同一個音一直被點名 —— 那仍然是一個拿得去練的結論
  if (top && !low.some((d) => d.id === 'pronounce')) {
    out.push({
      id: 'issue',
      icon: '🗣️',
      label: issueLabel(top.issue),
      text: `最近被點名 ${top.count} 次，是你最常見的發音問題`,
      mode: 'shadowing',
      cta: ctaFor('shadowing'),
    });
  }

  // 3. 還沒有資料的面向排最後 —— 它不是「問題」，是「還不知道」，
  //    但它確實是下一步該做的事（不練就永遠是空白）
  for (const dim of list) {
    if (dim.score !== null) continue;
    out.push({
      id: dim.id,
      icon: dim.icon,
      label: dim.label,
      text: `還沒有足夠的資料 —— ${dim.note}`,
      mode: dim.modes[0],
      cta: ctaFor(dim.modes[0]),
    });
  }

  return out.slice(0, limit);
}

/**
 * 按鈕上的字。**用分頁的名字而不是面向的名字** ——
 * 面向是「聽得懂」，但畫面下面那一列上寫的是「聽力」，
 * 按鈕講一個那裡找不到的詞，使用者會不知道自己按下去會去哪。
 */
function ctaFor(mode) {
  return `去練${modeMeta(mode).label}`;
}

/** 被點名最多次的那個音。次數不夠就當作沒有 —— 一兩次不是「你的問題」。 */
function topIssue(weak) {
  if (!weak || typeof weak.entries !== 'function') return null;
  let best = null;
  for (const [issue, count] of weak.entries()) {
    if (count < MIN_ISSUE_COUNT) continue;
    if (!best || count > best.count) best = { issue, count };
  }
  return best;
}
