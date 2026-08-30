// 一組練完之後的總結卡片。
//
// 抽成獨立模組跟 feedback-view.js 同一個理由：這張卡片要真的練完 5 句才看得到，
// 而練 5 句要 5 次真實的 API 呼叫。抽出來之後，測試可以直接餵一份總結進去驗畫面。

import { issueLabel } from './labels.js';
import { statTile } from './stat-tile.js';

/** 最多列幾種問題類型。列太多就沒有「這一組的重點」可言了。 */
const MAX_ISSUES = 3;

/**
 * @param {{stats: HTMLElement, issues: HTMLElement}} el
 * @param {object} summary `summariseSet()` 的結果
 */
export function renderSetSummary(el, summary) {
  el.stats.replaceChildren(
    statTile('這一組', `${summary.count} 句`),
    statTile('平均分數', summary.average === null ? '—' : String(summary.average)),
    statTile('最高 / 最低', summary.count ? `${summary.best} / ${summary.worst}` : '—')
  );

  el.issues.replaceChildren();

  if (summary.issues.length === 0) {
    // 沒被點名不是「沒有資料」，是好消息，要講出來
    const none = document.createElement('p');
    none.className = 'hint';
    none.textContent = '這一組沒有被點名的發音問題。';
    el.issues.append(none);
    return;
  }

  // 一組裡重複出現的錯誤類型，比單看某一句的分數有用得多 ——
  // 「五句裡有三句都是 th」是一個可以拿去練的結論，「平均 72 分」不是。
  const title = document.createElement('p');
  title.className = 'set__title';
  title.textContent = '這一組最常出現的問題';

  const list = document.createElement('ul');
  list.className = 'set__list';

  for (const issue of summary.issues.slice(0, MAX_ISSUES)) {
    const row = document.createElement('li');

    const tag = document.createElement('span');
    tag.className = 'chip chip--issue';
    tag.textContent = issueLabel(issue.issue);

    const words = document.createElement('span');
    words.className = 'set__words';
    words.textContent = `${issue.count} 次・${issue.words.slice(0, 4).join('、')}`;

    row.append(tag, words);
    list.append(row);
  }

  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = '接下來會多抽一些練得到這些音的句子。';
  el.issues.append(title, list, note);
}
