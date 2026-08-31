// 目標句與 AI 聽到的內容逐字比對。
//
// 純函式、不碰 DOM —— 這樣 `npm test` 可以直接在 Node 裡驗。
// 原本這段埋在 app.js 中間，比對規則沒有任何測試釘住；
// 而它壞掉的症狀（整句都標紅、或明明唸錯卻沒標）很容易被當成模型的問題。

/** 比對前先去掉大小寫與標點。撇號要留著，don't 跟 dont 不該被當成兩個字。 */
export function normalizeWord(w) {
  return w.toLowerCase().replace(/[^a-z0-9']/g, '');
}

/**
 * 用 LCS（最長共同子序列）找出目標句裡「有被唸到」的字的 index。
 *
 * 為什麼不逐字對位：使用者少唸一個字，後面全部會偏移一格，
 * 逐字比對會把整句都標成錯的 —— 那種畫面沒有任何參考價值。
 *
 * @returns {Set<number>} 對得上的 targetWords index
 */
export function matchedTargetIndices(targetWords, spokenWords) {
  const a = targetWords.map(normalizeWord);
  const b = spokenWords.map(normalizeWord);
  // dp[i][j] = a[i..] 與 b[j..] 的 LCS 長度
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matched = new Set();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      matched.add(i);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return matched;
}

/**
 * 取出 problem_words 裡的單字。
 *
 * 階段 7 把 problem_words 從字串陣列換成物件（word / heard / issue / tip_zh），
 * 但 `localStorage` 裡的舊紀錄還是字串 —— 使用者的紀錄不會因為我們改了 schema 就跟著變，
 * 所以兩種格式都要吃得下。
 */
export function problemWordText(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item.word === 'string') return item.word;
  return '';
}

/**
 * 把目標句拆成一個個「要不要標紅、為什麼」的項目，交給畫面去渲染。
 *
 * @param {string} targetText 目標句
 * @param {string} transcript AI 實際聽到的內容
 * @param {Array<string|{word:string}>} problemWords 模型點名發音有問題的字
 * @returns {Array<{word:string, miss:boolean, reason:''|'unheard'|'problem'}>}
 */
export function diffWords(targetText, transcript, problemWords = []) {
  const targetWords = String(targetText ?? '').split(/\s+/).filter(Boolean);
  const matched = matchedTargetIndices(targetWords, String(transcript ?? '').split(/\s+/));
  const problems = new Set(
    (Array.isArray(problemWords) ? problemWords : [])
      .map((item) => normalizeWord(problemWordText(item)))
      .filter(Boolean)
  );

  return targetWords.map((word, idx) => {
    // 「沒聽到」優先於「發音待加強」：字根本沒出現時，講「發音要加強」是誤導
    if (!matched.has(idx)) return { word, miss: true, reason: 'unheard' };
    if (problems.has(normalizeWord(word))) return { word, miss: true, reason: 'problem' };
    return { word, miss: false, reason: '' };
  });
}
