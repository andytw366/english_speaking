import { h, append } from '../lib/dom.js';
import { columns } from '../lib/layout.js';
import { PRACTICE_MODES } from '../lib/modes.js';
import { dailyState, overallToday } from '../lib/daily.js';
import { getSrsState, getActivity, activityToday } from '../lib/storage.js';
import { dayKey } from '../lib/practice.js';
import { bindKeys, indexOfKey } from '../lib/keys.js';

export const meta = { id: 'home', label: '今天', icon: '🏠' };

// 首頁存在的理由：六個分頁沒有一個回答得了「我今天該做什麼」。
// 資料全部都已經在了（每日計數表、每日目標、複習排程），缺的只是一個把它們
// 放在一起的畫面 —— 所以這個模組刻意沒有自己的狀態，只是讀與畫。

let root = null;

export async function mount(container) {
  root = container;
  render();
  // 別的模式練完回到首頁時要看到新的數字。設定改了（例如調高目標）也一樣。
  window.addEventListener('settings-changed', render);
  // 1–5 直接跳到清單上的那個模式（順序就是畫面上的順序）
  const unbindKeys = bindKeys((key) => {
    const i = indexOfKey(key, PRACTICE_MODES.length);
    if (i < 0) return false;
    goTo(PRACTICE_MODES[i].id);
    return true;
  });
  return () => {
    window.removeEventListener('settings-changed', render);
    unbindKeys();
    root = null;
  };
}

function render() {
  if (!root) return;
  // 主欄是「今天要做什麼」的清單，右邊放總數與複習排程 ——
  // 那兩張是看一眼的資訊，不是要動手的東西
  const { main, side } = columns(root);

  const activity = getActivity();
  const today = activityToday(activity, dayKey(new Date()));
  const overall = overallToday();
  const rows = PRACTICE_MODES.map((mode) => ({ mode, state: dailyState(mode.id) }));

  // 有目標的模式裡，全部達標了沒
  const withGoal = rows.filter((r) => r.state.goal > 0);
  const done = withGoal.filter((r) => r.state.done >= r.state.goal).length;

  // 總覽放主欄的最上面而不是輔助欄：窄螢幕上輔助欄是接在主欄**後面**的，
  // 而「今天練了幾個」正是這一頁的標題數字，不該掉到清單下面才看得到。
  // （桌機的側欄也有同一組數字，那是常駐的提醒；這裡是詳細版。）
  append(main,
    h('div', { class: 'card card--today' },
      h('div', { class: 'today' },
        h('div', { class: 'today__block' },
          h('span', { class: 'today__value' + (withGoal.length && done === withGoal.length ? ' today__value--done' : '') },
            String(today.total)),
          h('span', { class: 'today__label' }, '今天練了'),
        ),
        h('div', { class: 'today__block today__block--streak' },
          h('span', { class: 'today__value' }, String(overall.streak)),
          h('span', { class: 'today__label' }, '連續天數'),
        ),
      ),
      h('p', { class: 'hint' }, headline(withGoal.length, done, today.total)),
    ),

    h('div', { class: 'card' },
      h('p', { class: 'card__title' }, '今天的目標'),
      h('div', { class: 'homelist' }, rows.map(({ mode, state }) => modeRow(mode, state))),
      h('p', { class: 'hint' }, '每個模式練幾個可以在「設定 → 每日目標」調整。'),
    ),
  );

  append(side, reviewCard());
}

function headline(goalCount, doneCount, total) {
  if (goalCount === 0) return '沒有設每日目標。到「設定 → 每日目標」設一個，這裡就會有進度可以看。';
  if (doneCount === goalCount) return `今天的目標都完成了 🎉 想再多練都可以。`;
  if (total === 0) return '今天還沒開始。從下面挑一個開始就好，不必全部做完。';
  return `${goalCount} 個目標裡完成了 ${doneCount} 個。`;
}

function modeRow(mode, state) {
  const hasGoal = state.goal > 0;
  const complete = hasGoal && state.done >= state.goal;
  const percent = hasGoal ? Math.min(100, Math.round((state.done / state.goal) * 100)) : 0;

  return h('button', {
    class: 'homerow' + (complete ? ' homerow--done' : ''),
    onclick: () => goTo(mode.id),
  },
    h('span', { class: 'homerow__icon' }, mode.icon),
    h('span', { class: 'homerow__label' }, mode.label),
    h('span', { class: 'homerow__count' },
      hasGoal ? `${state.done} / ${state.goal} ${mode.unit}` : `${state.done} ${mode.unit}`),
    h('span', { class: 'tierbar' },
      h('span', {
        class: 'tierbar__fill ' + (complete ? 'tierbar__fill--mastered' : 'tierbar__fill--learning'),
        style: `width:${percent}%`,
      })),
    h('span', { class: 'homerow__note' },
      complete ? '✅ 今天完成了'
        : state.streak > 0 ? `連續 ${state.streak} 天`
        : hasGoal ? `還差 ${state.goal - state.done} ${mode.unit}` : '沒有設目標'),
  );
}

/**
 * 待複習的字。
 *
 * 直接數 `srs` 裡到期的筆數 —— **不用載入任何字庫檔**（六個分級加起來 3 MB）。
 * 首頁只需要一個數字，為了它把整個字庫抓下來太蠢。
 */
function reviewCard() {
  const now = Date.now();
  const due = Object.values(getSrsState()).filter((s) => (s?.due ?? 0) <= now).length;

  return h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '複習排程'),
    due > 0
      ? h('p', { class: 'hint' },
          `有 ${due} 個字到期了。單字卡會把它們排在最前面，所以直接開始練就會先複習到。`)
      : h('p', { class: 'hint' },
          '目前沒有到期的字。練過的字會依照 1 天 → 3 天 → 7 天 → 21 天的間隔回來。'),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn--primary', onclick: () => goTo('vocabulary') },
        due > 0 ? '去複習' : '練新的字'),
    ),
  );
}

/**
 * 切到別的模式。
 *
 * 用事件而不是直接呼叫 `app.js` 的 `switchTo()`：模式模組是被 `app.js` 動態
 * import 的，反過來 import 它會變成循環相依。
 */
function goTo(id) {
  window.dispatchEvent(new CustomEvent('switch-mode', { detail: id }));
}
