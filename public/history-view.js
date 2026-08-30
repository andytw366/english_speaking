// 練習紀錄卡片：統計磚、趨勢圖、最近的紀錄清單。

import { summarise } from './storage.js';
import { trendPoints, TREND_LIMIT } from './practice.js';
import { buildTrendChart } from './trend-chart.js';
import { categoryLabel, formatTime, scoreClass } from './labels.js';
import { statTile } from './stat-tile.js';

/** 清單最多列這麼多筆。再多就變成一整頁捲不完的東西，趨勢圖才是看長期的地方。 */
const LIST_LIMIT = 20;

/**
 * @param {object} el 紀錄卡片相關的元素
 * @param {object} context
 * @param {Array<object>} context.history 由新到舊
 * @param {Array<object>} context.sentences 目前的例句（判斷還能不能重練）
 * @param {(id: *) => void} context.onReplay 按下「重練這句」
 * @param {boolean} context.replayDisabled 錄音中要停用重練，不然錄好的音會對不上目標句
 * @param {(id: string) => string} context.labelForModel
 */
export function renderHistory(el, { history, sentences, onReplay, replayDisabled, labelForModel }) {
  if (history.length === 0) {
    el.card.hidden = true;
    el.trend.hidden = true;
    el.chart.replaceChildren();
    return;
  }
  el.card.hidden = false;

  const stats = summarise(history);
  el.stats.replaceChildren(
    statTile('練習次數', String(stats.count)),
    statTile('平均分數', stats.average === null ? '—' : String(stats.average)),
    statTile('最高分', stats.best === null ? '—' : String(stats.best))
  );

  renderTrend(el, history);

  el.list.replaceChildren();
  for (const record of history.slice(0, LIST_LIMIT)) {
    el.list.append(
      historyItem(record, { sentences, onReplay, replayDisabled, labelForModel })
    );
  }

  if (history.length > LIST_LIMIT) {
    const more = document.createElement('li');
    more.className = 'hint';
    more.textContent = `另有 ${history.length - LIST_LIMIT} 筆較早的紀錄未顯示。`;
    el.list.append(more);
  }
}

function historyItem(record, { sentences, onReplay, replayDisabled, labelForModel }) {
  const item = document.createElement('li');
  item.className = 'history__item';

  const score = document.createElement('span');
  score.className = `history__score ${scoreClass(record.score)}`;
  score.textContent = record.score;

  const main = document.createElement('div');
  main.className = 'history__main';

  const text = document.createElement('span');
  text.className = 'history__sentence';
  text.textContent = record.sentenceText ?? '';

  const meta = document.createElement('span');
  meta.className = 'history__meta';
  meta.textContent = [formatTime(record.at), categoryLabel(record.category), labelForModel(record.model)]
    .filter(Boolean)
    .join('・');

  main.append(text, meta);
  item.append(score, main);

  // 這句還在 sentences.json 裡才給重練 —— 例句改過之後舊紀錄可能對不到
  if (sentences.some((s) => s.id === record.sentenceId)) {
    const replay = document.createElement('button');
    replay.type = 'button';
    replay.className = 'btn btn--ghost btn--small history__replay';
    replay.textContent = '重練這句';
    replay.disabled = replayDisabled;
    replay.addEventListener('click', () => onReplay(record.sentenceId));
    item.append(replay);
  }

  return item;
}

function renderTrend(el, history) {
  const chart = buildTrendChart(trendPoints(history, TREND_LIMIT));

  // 只有一筆畫不出「走勢」，一條線兩個端點才有意義
  if (!chart) {
    el.trend.hidden = true;
    el.chart.replaceChildren();
    return;
  }
  el.trend.hidden = false;
  el.caption.textContent = chart.caption;
  el.chart.replaceChildren(chart.svg);
}
