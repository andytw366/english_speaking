// 每個模式的「今天練了幾個 / 目標幾個 / 連續幾天」。
//
// 抽出來的理由跟 `today-card.js` 一樣，但這一層管的是**數字**而不是畫面：
// 六個模式各自去讀計數表、算連續天數、跟設定裡的目標比對的話，
// 一定會有人算錯一種邊界（跨月、今天還沒練該不該歸零…）。

import {
  getActivity, activityCount, activityDays, activityToday, recordActivity, recordResult,
} from './storage.js';
import { dayKey, streakFromDays } from './practice.js';
import { goalOf } from './settings.js';
import { renderTodayCard } from './today-card.js';
import { modeMeta, PRACTICE_MODES } from './modes.js';

/**
 * 某個模式今天的狀態。
 *
 * @returns {{goal: number, done: number, streak: number, remaining: number}}
 *   `remaining` 在沒設目標（goal 0）時是 Infinity —— 呼叫端要嘛不限量，
 *   要嘛自己決定怎麼處理。
 */
export function dailyState(mode, now = Date.now()) {
  const activity = getActivity();
  const goal = goalOf(mode);
  const done = activityCount(activity, mode, dayKey(new Date(now)));

  return {
    goal,
    done,
    streak: streakFromDays(activityDays(activity, mode), now),
    remaining: goal > 0 ? Math.max(0, goal - done) : Infinity,
  };
}

/**
 * 跨模式的今天：總共練了幾個、連續幾天。
 *
 * **連續天數是「任何一個模式有練就算」**，不是各模式取最大值 ——
 * 昨天只練單字、今天只練跟讀，那也是連續兩天沒有斷；用「最長的那一個模式」
 * 會讓換著練的人看起來像沒在練。
 *
 * 放在這裡而不是首頁裡：外殼左側那兩個數字與首頁的大卡是同一組數字，
 * 各算各的就會在同一個畫面上出現兩個不一樣的連續天數。
 */
export function overallToday(now = Date.now()) {
  const activity = getActivity();
  const days = new Set();
  for (const mode of PRACTICE_MODES) {
    for (const day of activityDays(activity, mode.id)) days.add(day);
  }
  return {
    total: activityToday(activity, dayKey(new Date(now))).total,
    streak: streakFromDays(days, now),
  };
}

/**
 * 記一次練習。答對答錯都算 —— 今天的份算的是練習量，不是正確率。
 *
 * **成績也在這裡一起記**（`result`），而不是各模式自己去呼叫第二個函式：
 * 兩張表是一起長大的，分兩個呼叫點的話遲早有一個模式只記了其中一張，
 * 而那種錯誤完全沒有徵兆 —— 練習量正常累積，只有能力圖悄悄少算。
 *
 * 記完發一個事件：外殼左側的「今天練了 / 連續天數」不屬於任何一個模式，
 * 沒有這個通知就只會在切模式時才更新（練了一整輪，數字還停在進來時的樣子）。
 *
 * @param {string} mode
 * @param {object} [options]
 * @param {number} [options.n] 今天的份加幾（預設 1）
 * @param {Record<string, number>} [options.result]
 *   這一次的成績計數器，欄位見 `storage.js` 的 `RESULT_FIELDS`。
 *   省略 = 只記練習量（沒有成績可記的動作）
 */
export function recordPractice(mode, { n = 1, result = null } = {}) {
  const next = recordActivity(mode, n);
  if (result) recordResult(mode, result);
  window.dispatchEvent(new CustomEvent('practice-recorded', { detail: { mode, n } }));
  return next;
}

/**
 * 只記成績，**不動今天的份**。
 *
 * 給「判定比作答晚一步才知道」的情況用 —— 中翻英按下「對答案」時只有本地的
 * 關鍵字比對，模型的判定要兩秒後才回來，而今天的份在按下去那一刻就該加上去了
 * （不然關掉 App 那一題就白練了）。用 `recordPractice(mode, { n: 0 })` 也做得到，
 * 但那會讓「今天的份加 0」變成一個要在每個呼叫點讀懂的東西。
 *
 * @param {string} mode
 * @param {Record<string, number>} counters 欄位見 `storage.js` 的 `RESULT_FIELDS`
 */
export function recordOutcome(mode, counters) {
  if (!counters) return;
  recordResult(mode, counters);
}

/**
 * 那張「今天」的卡。單位與說明從 `modes.js` 拿，所以六個模式的措辭一致。
 *
 * @param {string} mode
 * @param {{control?: HTMLElement, hint?: string, now?: number}} [options]
 *   control 是目標的調整控制項（跟讀直接放在卡上，其餘放在設定裡）
 */
export function renderDailyCard(mode, { control = null, hint = '', now = Date.now() } = {}) {
  const meta = modeMeta(mode);
  const state = dailyState(mode, now);

  return renderTodayCard({
    done: state.done,
    goal: state.goal,
    streak: state.streak,
    unit: meta.unit ?? '個',
    label: meta.todayLabel ?? '今天練的',
    control,
    hint: hint || (state.goal > 0 && state.done < state.goal
      ? `再 ${state.goal - state.done} ${meta.unit}就達成今天的目標了。（每日目標在「設定」可以改）`
      : ''),
  });
}
