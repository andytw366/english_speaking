import { h } from './dom.js';

// 自由作答的比對邏輯，中翻英與情境對話共用。
//
// 為什麼不追求精確批改：同一個意思有很多種講法，逐字比對一定會誤判。
// 所以只分三級，並且永遠把參考答案秀出來讓使用者自己判斷。

export function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[.,!?;:"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(s) {
  return normalize(s).split(' ').filter(Boolean);
}

/**
 * @param {{accept: string[], keywords?: string[], strict?: boolean}} item
 * @returns {{level: 'empty'|'exact'|'close'|'wrong', missing?: string[]}}
 *   exact = 與某個可接受答案完全相符
 *   close = 關鍵字都有，但說法不同（算通過）
 *   wrong = 少了關鍵字
 */
export function grade(item, input) {
  const got = normalize(input);
  if (!got) return { level: 'empty' };

  if (item.accept.some((a) => normalize(a) === got)) return { level: 'exact' };

  // 填空題只考一個字，沒有「意思對就好」的空間
  if (item.strict) return { level: 'wrong' };

  const gotTokens = new Set(tokens(input));
  const missing = (item.keywords ?? []).filter(
    (kw) => !tokens(kw).every((t) => gotTokens.has(t))
  );
  return missing.length === 0 ? { level: 'close' } : { level: 'wrong', missing };
}

/**
 * 逐字對照。比對是位置無關的（集合比對），因為換句話說時語序本來就會變 ——
 * 標出來的是「有沒有用到這個字」，不是「位置對不對」。
 */
export function diffView(userText, referenceText) {
  const setUser = new Set(tokens(userText));
  const setRef = new Set(tokens(referenceText));

  const line = (text, otherSet, missClass) => {
    const words = text.trim().split(/\s+/);
    return h('p', { class: 'diff__line' },
      words.map((w, i) => [
        h('span', { class: otherSet.has(normalize(w)) ? 'dword' : `dword ${missClass}` }, w),
        i < words.length - 1 ? ' ' : '',
      ]));
  };

  return h('div', { class: 'diff' },
    h('p', { class: 'diff__label' }, '你的答案'),
    line(userText, setRef, 'dword--extra'),
    h('p', { class: 'diff__label' }, '參考答案'),
    line(referenceText, setUser, 'dword--missing'),
    h('p', { class: 'hint' }, '紅＝你沒寫到　灰＝你多寫的'),
  );
}

export const RESULT_HEAD = {
  exact: ['✅ 完全正確！', 'ok'],
  close: ['🟡 意思對了', 'close'],
  wrong: ['❌ 再想想', 'bad'],
  empty: ['請先寫下答案', 'bad'],
};
