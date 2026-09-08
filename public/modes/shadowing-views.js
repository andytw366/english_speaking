// 跟讀模式的幾張卡片：今天的進度、一組練完的總結、練習紀錄。
//
// 抽成獨立檔案的理由跟原本的分支一樣：這些畫面要「有一批紀錄」或「練完 5 句」
// 才看得到，用真實流程去生資料的話一次只生得出一筆，還要燒掉一次 API 呼叫。
// 抽出來之後測試可以直接餵資料進去驗。

import { h, append } from '../lib/dom.js';
import { toggleChip } from '../lib/fields.js';
import { statTile } from '../lib/stat-tile.js';
import { buildTrendChart } from '../lib/trend-chart.js';
import { summarise } from '../lib/storage.js';
import { categoryLabel, formatTime, issueLabel, scoreClass } from '../lib/labels.js';
import { trendPoints, TREND_LIMIT, SET_SIZE } from '../lib/practice.js';
import { renderDailyCard } from '../lib/daily.js';

/** 紀錄清單最多列這麼多筆。再多就變成一整頁捲不完的東西，趨勢圖才是看長期的地方。 */
const LIST_LIMIT = 20;

/** 每日目標的可選值。 */
export const GOAL_CHOICES = [3, 5, 10, 20];

// ─── 今天的進度與連續天數 ────────────────────────────────────────────────

/**
 * 卡片與數字都是六個模式共用的（`lib/today-card.js` 與 `lib/daily.js`）。
 * 這裡只負責跟讀專屬的部分：把每日目標的下拉選單放進卡片裡 ——
 * 跟讀是唯一把目標放在畫面上的模式，因為一次練幾句很看當下有多少時間。
 */
export function renderToday(goal, onGoalChange) {
  return renderDailyCard('shadowing', {
    // chip 而不是下拉：只有五個值，而下拉要多按一下才看得到自己有哪些選擇。
    // 設定頁的每日目標也是同一種控制項（`lib/fields.js`）
    control: h('div', { class: 'field today__goal' },
      h('span', { class: 'field__label' }, '每日目標'),
      h('div', { class: 'chips' },
        GOAL_CHOICES.map((n) => toggleChip(`${n} 句`, n === goal, () => onGoalChange(n)))),
    ),
  });
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
      h('span', { class: 'hint' }, '紀錄只存在這個瀏覽器裡。')),
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
