import { h, append } from '../lib/dom.js';
import { columns } from '../lib/layout.js';
import { PRACTICE_MODES } from '../lib/modes.js';
import { dailyState, overallToday } from '../lib/daily.js';
import { getSrsState, getActivity, activityToday, getResults, getHistory } from '../lib/storage.js';
import { dayKey, weakIssues } from '../lib/practice.js';
import { issueLabel } from '../lib/labels.js';
import { computeAbility, topWeaknesses } from '../lib/ability.js';
import { buildRadarChart } from '../lib/radar-chart.js';
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

    // 能力量表排在目標清單**前面**，而且在主欄。
    //
    // 為什麼不是輔助欄：輔助欄的 DOM 順序就是手機上的順序（窄螢幕時它接在主欄
    // 後面），而「我現在的問題是什麼」放在五行清單後面等於手機上要捲過去才看得到
    // —— 首頁的總覽卡當年就是因此從輔助欄搬回主欄的。
    //
    // 為什麼排在目標清單前面：清單回答「今天還差多少」，量表回答「我該練哪一個」。
    // 先知道該練哪一個，那份清單才知道要從哪一行開始看。
    abilityCard(),

    h('div', { class: 'card' },
      h('p', { class: 'card__title' }, '今天的目標'),
      h('div', { class: 'homelist' }, rows.map(({ mode, state }) => modeRow(mode, state))),
      h('p', { class: 'hint' }, '練幾個可以在「設定 → 每日目標」調整。'),
    ),
  );

  append(side, reviewCard());
}

function headline(goalCount, doneCount, total) {
  if (goalCount === 0) return '沒有設每日目標。到「設定 → 每日目標」設一個就會有進度可以看。';
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
 * 四個能力面向 + 現在最該練什麼。
 *
 * **不載入任何字庫檔**（首頁的老規矩）：四個面向全部從 `results`（每日成績表）、
 * `srs`（盒號）與跟讀的 `history` 算得出來，一個字庫檔都不用碰。
 *
 * 圖與排行榜是**同一張卡上的兩個東西**，刻意不拆開：
 * 圖給的是一眼的高低（「聽力那一格比較短」），而那不是一個可以拿去做的結論。
 * 排行榜把同一份數字翻成「最近 20 題只對 11 題，去練聽力」，並且每一行都點得下去。
 * 拆成兩張卡的話，使用者會以為那是兩種不同的資訊。
 */
function abilityCard() {
  const dims = computeAbility({ results: getResults(), srsState: getSrsState() });
  const chart = buildRadarChart(dims);
  const weak = topWeaknesses(dims, { weak: weakIssues(getHistory()), issueLabel });
  const scored = dims.filter((d) => typeof d.score === 'number');

  const card = h('div', { class: 'card card--ability' },
    h('p', { class: 'card__title' }, '目前的能力'),
    // 圖與文字在寬螢幕上並排（CSS 的 .ability__top）—— 圖本身最寬 300px，
    // 主欄有 720px，上下排的話右邊那 400px 是空的，而這張卡又特別高
    h('div', { class: 'ability__top' },
      h('figure', { class: 'radar' },
        h('div', { class: 'radar__chart' }, chart.svg),
      ),
      // 量（練過幾個字、最近幾題）用文字寫在圖旁邊 —— 圖上那四條只講「熟不熟」，
      // 講不了「你會幾個字」。理由完整版在 `lib/ability.js` 的開頭
      h('ul', { class: 'ability__detail' },
        dims.map((d) => h('li', {},
          h('span', { class: 'ability__dim' }, `${d.icon} ${d.label}`),
          h('span', { class: 'ability__text' }, d.detail),
        ))),
    ),
    // 圖的文字說明。讀螢幕的人看不到那張圖，四個數字要用文字再講一次 ——
    // 跟趨勢圖的 figcaption 同一個規矩
    h('p', { class: 'hint', id: 'radar-caption' }, chart.caption),
  );

  if (weak.length > 0) {
    append(card,
      h('p', { class: 'card__title card__title--sub' },
        scored.length > 0 ? '現在最該練什麼' : '先把資料練出來'),
      h('ol', { class: 'weaklist' }, weak.map((w) => h('li', { class: 'weakrow' },
        h('span', { class: 'weakrow__icon' }, w.icon),
        h('div', { class: 'weakrow__main' },
          h('span', { class: 'weakrow__label' }, w.label),
          h('span', { class: 'weakrow__text' }, w.text)),
        h('button', {
          class: 'btn btn--small', onclick: () => goTo(w.mode),
        }, w.cta)))));
  }

  return card;
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
      ? h('p', { class: 'hint' }, `有 ${due} 個字到期了 —— 單字卡會把它們排在最前面。`)
      : h('p', { class: 'hint' }, '目前沒有到期的字。'),
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
