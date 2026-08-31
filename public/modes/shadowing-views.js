// 跟讀模式的幾張卡片：今天的進度、一組練完的總結、練習紀錄。
//
// 抽成獨立檔案的理由跟原本的分支一樣：這些畫面要「有一批紀錄」或「練完 5 句」
// 才看得到，用真實流程去生資料的話一次只生得出一筆，還要燒掉一次 API 呼叫。
// 抽出來之後測試可以直接餵資料進去驗。

import { h, append } from '../lib/dom.js';
import { statTile } from '../lib/stat-tile.js';
import { buildTrendChart } from '../lib/trend-chart.js';
import { summarise } from '../lib/storage.js';
import { categoryLabel, formatTime, issueLabel, scoreClass } from '../lib/labels.js';
import { trendPoints, TREND_LIMIT, streakDays, todayCount, SET_SIZE } from '../lib/practice.js';

/** 紀錄清單最多列這麼多筆。再多就變成一整頁捲不完的東西，趨勢圖才是看長期的地方。 */
const LIST_LIMIT = 20;

/** 每日目標的可選值。 */
export const GOAL_CHOICES = [3, 5, 10, 20];

// ─── 今天的進度與連續天數 ────────────────────────────────────────────────

/**
 * 練習紀錄回答的是「我練得怎麼樣」，但沒有回答「我今天練了嗎」。
 * 各大英語學習 App 都有的 streak／每日目標解的就是這件事 ——
 * 它不是遊戲化的裝飾，而是把「每天回來」這個行為本身變成看得見的東西。
 */
export function renderToday(history, goal, onGoalChange) {
  const done = todayCount(history);
  const streak = streakDays(history);
  const percent = Math.min(100, Math.round((done / goal) * 100));

  return h('div', { class: 'card card--today' },
    h('div', { class: 'today' },
      h('div', { class: 'today__block' },
        // 達成目標時數字才變色。平常就是彩色的話，達標與否就看不出差別了
        h('span', { class: 'today__value' + (done >= goal ? ' today__value--done' : '') },
          `${done} / ${goal}`),
        h('span', { class: 'today__label' }, '今天練的句子'),
        h('span', { class: 'today__bar' },
          h('span', { class: 'today__fill', style: `width: ${percent}%` })),
      ),
      h('div', { class: 'today__block today__block--streak' },
        h('span', { class: 'today__value' }, String(streak)),
        h('span', { class: 'today__label' }, '連續天數'),
      ),
      h('label', { class: 'field field--inline today__goal' },
        h('span', { class: 'field__label' }, '每日目標'),
        h('select', {
          class: 'select',
          onchange: (e) => onGoalChange(Number(e.target.value)),
        }, GOAL_CHOICES.map((n) => h('option', { value: String(n), selected: n === goal }, `${n} 句`))),
      ),
    ),
    h('p', { class: 'hint' }, todayNote(done, goal, streak)),
  );
}

/**
 * 刻意不寫「你今天還沒練，連續天數要斷了」這種話 —— 用罰的去推人回來，
 * 短期有效，長期只會讓人不想打開。這裡只講事實跟還差幾句。
 */
function todayNote(done, goal, streak) {
  if (done >= goal) {
    return streak > 1
      ? `今天的目標達成了，連續 ${streak} 天。`
      : '今天的目標達成了。要再多練幾句也沒問題。';
  }
  if (done > 0) return `再 ${goal - done} 句就達成今天的目標了。`;
  if (streak > 0) return `已經連續 ${streak} 天，今天練 ${goal} 句就接得下去。`;
  return `今天練 ${goal} 句就算達成目標。`;
}

// ─── 一組練完的總結 ──────────────────────────────────────────────────────

/** 最多列幾種問題類型。列太多就沒有「這一組的重點」可言了。 */
const MAX_ISSUES = 3;

export function renderSetSummary(summary, onNext) {
  const issues = summary.issues.length > 0
    ? [
        // 一組裡重複出現的錯誤類型，比單看某一句的分數有用得多 ——
        // 「五句裡有三句都是 th」是一個可以拿去練的結論，「平均 72 分」不是。
        h('p', { class: 'set__title' }, '這一組最常出現的問題'),
        h('ul', { class: 'set__list' },
          summary.issues.slice(0, MAX_ISSUES).map((issue) =>
            h('li', {},
              h('span', { class: 'chip chip--issue' }, issueLabel(issue.issue)),
              h('span', { class: 'set__words' },
                `${issue.count} 次・${issue.words.slice(0, 4).join('、')}`)))),
        h('p', { class: 'hint' }, '接下來會多抽一些練得到這些音的句子。'),
      ]
    // 沒被點名不是「沒有資料」，是好消息，要講出來
    : [h('p', { class: 'hint' }, '這一組沒有被點名的發音問題。')];

  return h('div', { class: 'card card--set' },
    h('p', { class: 'card__title' }, '這一組練完了'),
    h('div', { class: 'stats' },
      statTile('這一組', `${summary.count} 句`),
      statTile('平均分數', summary.average === null ? '—' : String(summary.average)),
      statTile('最高 / 最低', summary.count ? `${summary.best} / ${summary.worst}` : '—'),
    ),
    h('div', { class: 'set__issues' }, issues),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn--primary', onclick: onNext }, `再練一組（${SET_SIZE} 句）`)),
  );
}

// ─── 練習紀錄 ────────────────────────────────────────────────────────────

/**
 * @param {Array<object>} history 由新到舊
 * @param {Array<object>} sentences 目前的例句（判斷還能不能重練）
 * @param {(id:*) => void} onReplay 按下「重練這句」
 * @param {() => void} onClear 清除所有紀錄
 * @param {boolean} replayDisabled 錄音中要停用重練，不然錄好的音會對不上目標句
 */
export function renderHistory(history, { sentences, onReplay, onClear, replayDisabled }) {
  if (history.length === 0) return null;

  const stats = summarise(history);
  const card = h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '練習紀錄'),
    h('div', { class: 'stats' },
      statTile('練習次數', String(stats.count)),
      statTile('平均分數', stats.average === null ? '—' : String(stats.average)),
      statTile('最高分', stats.best === null ? '—' : String(stats.best)),
    ),
  );

  const chart = buildTrendChart(trendPoints(history, TREND_LIMIT));
  // 只有一筆畫不出「走勢」，一條線兩個端點才有意義
  if (chart) {
    append(card, h('figure', { class: 'trend' },
      h('figcaption', { class: 'hint', id: 'trend-caption' }, chart.caption),
      h('div', { class: 'trend__chart' }, chart.svg)));
  }

  append(card,
    h('ol', { class: 'history' },
      history.slice(0, LIST_LIMIT).map((record) =>
        historyItem(record, { sentences, onReplay, replayDisabled })),
      history.length > LIST_LIMIT &&
        h('li', { class: 'hint' }, `另有 ${history.length - LIST_LIMIT} 筆較早的紀錄未顯示。`)),
    h('div', { class: 'row history__actions' },
      h('button', { class: 'btn', onclick: onClear }, '清除所有紀錄'),
      h('span', { class: 'hint' }, '紀錄只存在這台電腦的瀏覽器裡，不會上傳。')),
  );
  return card;
}

function historyItem(record, { sentences, onReplay, replayDisabled }) {
  const item = h('li', { class: 'history__item' },
    h('span', { class: `history__score ${scoreClass(record.score)}` },
      typeof record.score === 'number' ? String(record.score) : '—'),
    h('div', { class: 'history__main' },
      h('span', { class: 'history__sentence' }, record.sentenceText ?? ''),
      h('span', { class: 'history__meta' },
        [formatTime(record.at), categoryLabel(record.category), providerLabel(record.provider)]
          .filter(Boolean).join('・'))),
  );

  // 這句還在句庫裡才給重練 —— 例句改過之後舊紀錄可能對不到
  if (sentences.some((s) => s.id === record.sentenceId)) {
    append(item, h('button', {
      class: 'btn btn--ghost btn--small history__replay',
      disabled: replayDisabled,
      onclick: () => onReplay(record.sentenceId),
    }, '重練這句'));
  }
  return item;
}

function providerLabel(provider) {
  return { azure: 'Azure 評分', gemini: 'Gemini 評分' }[provider] ?? '';
}
