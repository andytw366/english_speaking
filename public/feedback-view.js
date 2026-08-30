// 講評卡片與目標句的標色。
//
// 這裡只負責「把資料畫出來」，不決定要不要計入紀錄、也不呼叫 API。

import { diffWords } from './text-diff.js';

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
