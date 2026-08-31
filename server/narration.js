// 中文講評的兩件事：要不要呼叫 Gemini、以及不呼叫時怎麼用 Azure 的數字組一段摘要。
//
// 為什麼獨立成一個模組：這兩段都是純邏輯（沒有網路、沒有 express），
// 抽出來才測得到 —— server/index.js 一 import 就會 app.listen()，進不了 node:test。
//
// 設計上的分工：**Azure 的分數是主角，Gemini 的講評是配角。**
// 所以講評缺席（沒金鑰、超時、使用者自己關掉）都不是錯誤，只是換一種呈現，
// 而每一種缺席的原因要給不同的說明 —— 「你關掉了」跟「這次沒回來」
// 對使用者是完全不同的兩件事，寫成同一句話只會讓人以為壞了。

/** 講評缺席的原因。會回給前端，決定畫面上那行小字怎麼寫。 */
export const NARRATION_REASONS = ['disabled', 'no_key', 'failed', 'gemini_scores'];

/**
 * 前端送上來的 narrate 欄位要不要呼叫 Gemini 講評。
 *
 * 預設是「要」—— 沒送這個欄位的舊前端行為不變。只有明確關掉才是關掉。
 * multipart 的欄位一律是字串，所以這裡收的是字串而不是 boolean。
 */
export function wantsNarration(raw) {
  if (raw === undefined || raw === null) return true;
  const v = String(raw).trim().toLowerCase();
  if (v === '') return true;
  return !['off', 'false', '0', 'no'].includes(v);
}

const ERROR_LABEL = {
  Mispronunciation: '發音不準',
  Omission: '沒有唸到',
  Insertion: '多唸了',
  UnexpectedBreak: '中間多了停頓',
  MissingBreak: '少了該有的停頓',
  Monotone: '語調太平',
};

// 最後一行要說明「為什麼這段不是 Gemini 寫的」。
// 沒有這行的話，關掉講評之後畫面看起來就只是講評變得比較呆板，
// 使用者不會知道那是自己按的開關造成的、也不知道怎麼換回來。
const CLOSING = {
  disabled: '•（中文講評已關閉，這段是本地摘要。要更具體的建議可以到「設定」重新開啟，' +
    '代價是每次多等幾秒。）',
  no_key: '•（設定 GEMINI_API_KEY 之後，這裡會換成更具體的中文教練建議）',
  failed: '•（這次的 Gemini 講評沒有回來，已改用本地摘要。分數不受影響，' +
    '可以直接繼續練；一直失敗的話請看伺服器 console。）',
};

/**
 * 沒有用 Gemini 講評時，直接用 Azure 的數字組一段中文摘要。
 * 這樣只設定 Azure、或把講評關掉，也都能得到可讀的回饋。
 *
 * @param {object} assessment assessPronunciation() 的回傳值
 * @param {{ reason?: 'disabled'|'no_key'|'failed' }} options 講評缺席的原因
 */
export function localSummary(assessment, { reason = 'no_key' } = {}) {
  const s = assessment?.scores ?? {};
  const lines = [];

  const dimensions = [
    ['準確度', s.accuracy, '個別音發得準不準'],
    ['流暢度', s.fluency, '字與字之間的停頓是否自然'],
    ['完整度', s.completeness, '有沒有漏字'],
    ['語調', s.prosody, '重音、語調與節奏'],
  ].filter(([, v]) => typeof v === 'number');

  const weakest = dimensions.slice().sort((a, b) => a[1] - b[1])[0];
  if (weakest) {
    lines.push(`• 最需要加強的是「${weakest[0]}」（${Math.round(weakest[1])} 分）—— ${weakest[2]}。`);
  }

  const problems = (assessment?.words ?? []).filter(
    (w) => w.errorType !== 'None' || (w.accuracy ?? 100) < 60
  );
  for (const w of problems.slice(0, 3)) {
    const label = ERROR_LABEL[w.errorType] ?? `準確度偏低（${w.accuracy}）`;

    const weakPhonemes = (w.phonemes ?? [])
      .filter((p) => (p.accuracy ?? 100) < 60)
      .map((p) => p.phoneme);
    lines.push(
      `• 「${w.word}」：${label}` +
        (weakPhonemes.length ? `，特別是 ${weakPhonemes.join('、')} 這幾個音` : '')
    );
  }

  if (problems.length === 0) lines.push('• 每個字都唸得不錯，繼續保持！');
  lines.push(CLOSING[reason] ?? CLOSING.no_key);

  return lines.join('\n');
}
