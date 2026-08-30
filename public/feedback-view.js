// 講評卡片與目標句的標色。
//
// 這裡只負責「把資料畫出來」，不決定要不要計入紀錄、也不呼叫 API。

import { diffWords, problemWordText } from './text-diff.js';
import { issueLabel } from './labels.js';
import { speak } from './speech.js';

/**
 * 把目標句重畫成一個個 span，沒對上或被點名的字標色。
 *
 * @param {HTMLElement} sentenceEl 顯示目標句的元素
 */
export function highlightSentence(sentenceEl, sentenceText, transcript, problemWords = []) {
  const words = diffWords(sentenceText, transcript, problemWords);

  sentenceEl.replaceChildren();
  words.forEach(({ word, miss, reason }, idx) => {
    const span = document.createElement('span');
    span.textContent = word;
    if (miss) {
      span.className = 'word--miss';
      span.title =
        reason === 'unheard' ? '這個字沒有聽到，或唸得不一樣' : '這個字的發音需要加強';
    }
    sentenceEl.append(span);
    if (idx < words.length - 1) sentenceEl.append(' ');
  });
}

/**
 * 畫出講評。
 *
 * @param {{card: HTMLElement, body: HTMLElement, sentence: HTMLElement}} el
 * @param {object} data /api/pronunciation-feedback 的回應
 * @param {{sentenceText: string, labelForModel: (id: string) => string}} context
 */
/**
 * 逐字的發音問題：唸成什麼、屬於哪一類、嘴巴該怎麼做，外加單字的示範發音。
 *
 * 為什麼要有這一段：只說「thoroughly 發音不準」對練習沒有幫助 ——
 * 使用者不知道自己唸成了什麼，也不知道要怎麼改。ELSA 那類 App 的核心價值
 * 就在這裡，而不是那個分數。
 *
 * 每個字旁邊給一個單獨的播放鍵，是因為整句示範聽三次也未必抓得到那一個音。
 *
 * @returns {HTMLElement|null} 沒有問題字時回 null（不要留一個空的區塊）
 */
function renderProblemWords(list) {
  const items = (Array.isArray(list) ? list : [])
    .map((item) => (typeof item === 'string' ? { word: item } : item))
    .filter((item) => problemWordText(item));

  if (items.length === 0) return null;

  const section = document.createElement('div');
  section.className = 'problems';

  const heading = document.createElement('p');
  heading.className = 'problems__title';
  heading.textContent = '這幾個字可以再練';
  section.append(heading);

  const list_ = document.createElement('ul');
  list_.className = 'problems__list';

  for (const item of items) {
    const row = document.createElement('li');
    row.className = 'problems__item';

    const head = document.createElement('div');
    head.className = 'problems__head';

    const word = document.createElement('span');
    word.className = 'problems__word';
    word.textContent = item.word;

    const tag = document.createElement('span');
    tag.className = 'chip chip--issue';
    tag.textContent = issueLabel(item.issue);

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'btn btn--ghost btn--small problems__play';
    play.textContent = '🔊 單字';
    play.title = `聽 ${item.word} 的發音`;
    // 單字放慢一點 —— 這裡的目的是聽清楚那個音，不是聽自然的語速
    play.addEventListener('click', () => speak(item.word, { rate: 0.75 }));

    head.append(word, tag, play);
    row.append(head);

    // 「你唸成什麼」只在確實不一樣時才寫；一樣的話那行字只會讓人困惑
    if (item.heard && item.heard.toLowerCase() !== item.word.toLowerCase()) {
      const heard = document.createElement('p');
      heard.className = 'problems__heard';
      heard.textContent = `你唸成：${item.heard}`;
      row.append(heard);
    }

    if (item.tip_zh) {
      const tip = document.createElement('p');
      tip.className = 'problems__tip';
      tip.textContent = item.tip_zh;
      row.append(tip);
    }

    list_.append(row);
  }

  section.append(list_);
  return section;
}

export function renderFeedback(el, data, { sentenceText, labelForModel }) {
  el.body.replaceChildren();

  // 沒偵測到人聲：不要顯示「0 分」，那看起來像是發音很爛，
  // 實際上是根本沒錄到東西 —— 兩件事給使用者的訊息完全不同。
  if (data?.speech_detected === false) {
    const body = document.createElement('p');
    body.style.whiteSpace = 'pre-wrap';
    body.textContent = data.feedback_zh ?? '沒有偵測到人聲，請重新錄音。';
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = '這次不會計入練習紀錄。';
    el.body.append(body, note);
    el.card.hidden = false;
    return;
  }

  if (data?.transcript) {
    highlightSentence(el.sentence, sentenceText, data.transcript, data.problem_words);
  }

  if (typeof data?.score === 'number') {
    const score = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = `參考分數：${data.score} / 100`;
    score.append(strong);
    const disclaimer = document.createElement('p');
    disclaimer.className = 'hint';
    disclaimer.textContent = '這是 AI 的主觀評估，僅供參考，不是標準化測驗分數。';
    el.body.append(score, disclaimer);
  }

  if (data?.transcript) {
    const heard = document.createElement('p');
    heard.className = 'hint';
    heard.textContent = `AI 聽到的內容：${data.transcript}`;
    const legend = document.createElement('p');
    legend.className = 'hint';
    legend.textContent = '上方句子中標紅的字，是沒被聽到、或發音需要加強的部分。';
    el.body.append(heard, legend);
  }

  const problems = renderProblemWords(data?.problem_words);
  if (problems) el.body.append(problems);

  const body = document.createElement('p');
  body.style.whiteSpace = 'pre-wrap';
  body.textContent = data?.feedback_zh ?? '（沒有收到講評內容）';
  el.body.append(body);

  if (data?.model) {
    const by = document.createElement('p');
    by.className = 'hint';
    by.textContent = `由 ${labelForModel(data.model)} 評分`;
    el.body.append(by);
  }

  el.card.hidden = false;
}
