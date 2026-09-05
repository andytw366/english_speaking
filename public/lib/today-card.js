import { h } from './dom.js';

// 「今天練了幾個 / 目標幾個」加連續天數的那張卡。跟讀與單字卡共用。
//
// 為什麼值得有這個東西：練習紀錄回答的是「我練得怎麼樣」，但沒有回答
// 「我今天練了嗎」。各大英語學習 App 都有的 streak／每日目標解的就是這件事 ——
// 它不是遊戲化的裝飾，而是把「每天回來」這個行為本身變成看得見的東西。
//
// 為什麼抽成共用模組：兩個模式的這張卡長得一樣、鼓勵的話術也該一樣。
// 各寫一份的話，改了其中一邊的文案，另一邊就會慢慢變成另一種語氣。

/**
 * @param {object} args
 * @param {number} args.done   今天已經練了幾個
 * @param {number} args.goal   今天的目標。0 或負數代表沒有設目標
 * @param {number} args.streak 連續天數
 * @param {string} args.unit   數量後面接的量詞：'句'、'個字'（「再 3 句」「再 3 個字」）
 * @param {string} args.label  數字下面的說明：'今天練的句子'、'今天練的字'
 *   —— 跟 unit 分開是因為中文湊不出來：'今天練的' + '個字' 會變成「今天練的個字」
 * @param {HTMLElement|null} [args.control] 目標的調整控制項（跟讀直接放在卡上）
 * @param {string} [args.hint] 取代預設的那句話（例如「每日目標在設定裡改」）
 */
export function renderTodayCard({ done, goal, streak, unit, label, control = null, hint = '' }) {
  const hasGoal = goal > 0;
  const percent = hasGoal ? Math.min(100, Math.round((done / goal) * 100)) : 0;

  return h('div', { class: 'card card--today' },
    h('div', { class: 'today' },
      h('div', { class: 'today__block' },
        // 達成目標時數字才變色。平常就是彩色的話，達標與否就看不出差別了
        h('span', { class: 'today__value' + (hasGoal && done >= goal ? ' today__value--done' : '') },
          hasGoal ? `${done} / ${goal}` : String(done)),
        h('span', { class: 'today__label' }, label),
        hasGoal && h('span', { class: 'today__bar' },
          h('span', { class: 'today__fill', style: `width: ${percent}%` })),
      ),
      h('div', { class: 'today__block today__block--streak' },
        h('span', { class: 'today__value' }, String(streak)),
        h('span', { class: 'today__label' }, '連續天數'),
      ),
      control,
    ),
    h('p', { class: 'hint' }, hint || todayNote(done, goal, streak, unit)),
  );
}

/**
 * 刻意不寫「你今天還沒練，連續天數要斷了」這種話 —— 用罰的去推人回來，
 * 短期有效，長期只會讓人不想打開。這裡只講事實跟還差幾個。
 */
export function todayNote(done, goal, streak, unit) {
  if (goal <= 0) {
    return done > 0 ? `今天練了 ${done} ${unit}。` : '沒有設每日目標，想練多少都可以。';
  }
  if (done >= goal) {
    return streak > 1
      ? `今天的目標達成了，連續 ${streak} 天。`
      : `今天的目標達成了。要再多練幾${unit}也沒問題。`;
  }
  if (done > 0) return `再 ${goal - done} ${unit}就達成今天的目標了。`;
  if (streak > 0) return `已經連續 ${streak} 天，今天練 ${goal} ${unit}就接得下去。`;
  return `今天練 ${goal} ${unit}就算達成目標。`;
}
