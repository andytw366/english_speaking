// 每個模式的「今天練了幾個 / 目標幾個 / 連續幾天」。
//
// 抽出來的理由跟 `today-card.js` 一樣，但這一層管的是**數字**而不是畫面：
// 六個模式各自去讀計數表、算連續天數、跟設定裡的目標比對的話，
// 一定會有人算錯一種邊界（跨月、今天還沒練該不該歸零…）。

import { getActivity, activityCount, activityDays, recordActivity } from './storage.js';
import { dayKey, streakFromDays } from './practice.js';
import { goalOf } from './settings.js';
import { renderTodayCard } from './today-card.js';
import { modeMeta } from './modes.js';

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

/** 記一次練習。答對答錯都算 —— 今天的份算的是練習量，不是正確率。 */
export function recordPractice(mode, n = 1) {
  return recordActivity(mode, n);
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
