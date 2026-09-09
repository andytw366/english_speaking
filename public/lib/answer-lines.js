// 對完答案之後最上面那兩句：**AI 改的那句在上，教材的參考答案在下**。
//
// 為什麼是「兩句並列」而不是一張 AI 卡加一張參考答案卡：
// 使用者寫完一句話之後只想知道一件事 —— 「那到底該怎麼說」。
// 這個問題有兩個答案，而它們回答的角度不一樣：
//
//   🤖 AI 改的     看的是**你寫的那一句**，把它改成母語人士會說的樣子
//   📘 參考答案    教材寫死的那一句（免費、離線、每次都一樣）
//
// 以前 AI 那段接在整張結果卡的最後面，要捲過逐字比對、其他說法、教材說明
// 才看得到 —— 而那正是最貼近「我剛剛寫的東西」的一段。
// 現在兩句排在最上面、一眼可以對照，其餘的細節收到下面的摺疊裡。
//
// 這一份**情境對話與中翻英共用**（兩個模式問的是同一個問題）。

import { h } from './dom.js';
import { speak, isSupported as ttsSupported } from './tts.js';

/**
 * 兩句並列的外框。傳進來的 row 是 `sentenceRow()` 產出的，null 會被略過
 * —— AI 修正關掉時就只剩參考答案那一行，版面不會留一個空洞。
 */
export function answerPair(...rows) {
  return h('div', { class: 'pair' }, rows.flat().filter(Boolean));
}

/**
 * 並列裡的一行：左邊一個標籤，右邊一句話（可以唸出來）。
 *
 * @param {string} label 「🤖 AI 改的」「📘 參考答案」
 * @param {string|Node} body 那一句話，或任何要放在那個位置的節點
 *   （還在等模型、或一顆「讓 AI 看我這一句」的按鈕都走同一個位置）
 * @param {{tone?: string, speakText?: string, extraClass?: string}} options
 *   tone 決定左邊那條色帶：ai / ref / ok / close / bad
 *   speakText 有值才畫喇叭（按鈕本身要瀏覽器支援 TTS）
 *   extraClass 多掛一個類別。AI 那一行固定掛 `airev`，因為兩個模式的 `A` 鍵
 *     是靠它找到「讓 AI 看我這一句」那顆按鈕的（見各模式的 `onKey()`）
 */
export function sentenceRow(label, body, { tone = '', speakText = '', extraClass = '' } = {}) {
  return h('div', { class: 'pair__row' + (tone ? ` pair__row--${tone}` : '') + (extraClass ? ` ${extraClass}` : '') },
    h('span', { class: 'pair__label' }, label),
    h('div', { class: 'pair__body' },
      typeof body === 'string' ? h('p', { class: 'pair__text' }, body) : body,
      speakText && ttsSupported() && h('button', {
        class: 'pair__play',
        title: '唸這一句',
        'aria-label': `唸出「${label}」`,
        onclick: (e) => replay(speakText, e.currentTarget),
      }, '🔊'),
    ),
  );
}

/**
 * 收起來的細節。**這裡放的是「想追究的時候才看」的東西** ——
 * 逐字比對、其他說法、教材的用法說明、以及那句話是哪個模型產生的。
 *
 * 為什麼收起來而不是刪掉：這些東西第一次看有用、第二十次就是雜訊，
 * 而刪掉的話想追究的人就沒有地方可以追究了。
 */
export function moreBox(summary, ...children) {
  const kids = children.flat().filter(Boolean);
  if (kids.length === 0) return null;
  return h('details', { class: 'more' },
    h('summary', { class: 'more__summary' }, summary),
    h('div', { class: 'more__body' }, kids),
  );
}

async function replay(text, button) {
  button.disabled = true;
  try {
    await speak(text);
  } catch (err) {
    console.error('[tts]', err);
  } finally {
    button.disabled = false;
  }
}
