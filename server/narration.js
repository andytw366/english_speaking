// 中文講評的純邏輯：要不要呼叫、prompt 長什麼樣、回來的東西怎麼整理，
// 以及完全不呼叫時怎麼用 Azure 的數字組一段摘要。
//
// 為什麼獨立成一個模組：這兩段都是純邏輯（沒有網路、沒有 express），
// 抽出來才測得到 —— server/index.js 一 import 就會 app.listen()，進不了 node:test。
//
// 設計上的分工：**Azure 的分數是主角，Gemini 的講評是配角。**
// 所以講評缺席（沒金鑰、超時、使用者自己關掉）都不是錯誤，只是換一種呈現，
// 而每一種缺席的原因要給不同的說明 —— 「你關掉了」跟「這次沒回來」
// 對使用者是完全不同的兩件事，寫成同一句話只會讓人以為壞了。

/**
 * prompt 放在這裡而不是各家 provider 裡，是為了讓「換模型」真的只換模型。
 *
 * 同一段文字送給不同的模型，回來的東西才有得比 —— prompt 各寫一份的話，
 * 換過去覺得變好或變差，你分不出是模型的差別還是 prompt 的差別。
 */
export function buildNarrationPrompt(assessment) {
  const problems = (assessment?.words ?? [])
    .filter((w) => w.errorType !== 'None' || (w.accuracy ?? 100) < 80)
    .map((w) => {
      const phonemes = (w.phonemes ?? [])
        .filter((p) => (p.accuracy ?? 100) < 70)
        .map((p) => `${p.phoneme}(${p.accuracy})`)
        .join(' ');
      return `- ${w.word}：準確度 ${w.accuracy}，狀況 ${w.errorType}` +
        (phonemes ? `，較弱的音素 ${phonemes}` : '');
    })
    .join('\n');

  const s = assessment?.scores ?? {};
  return `你是一位英語發音教練。以下是語音評估系統對一段錄音的客觀分析結果。

目標句：「${assessment?.referenceText}」
系統聽到：「${assessment?.recognizedText}」

整體分數（滿分 100）：
- 發音總分 ${s.pronunciation}
- 準確度 ${s.accuracy}
- 流暢度 ${s.fluency}
- 完整度 ${s.completeness}
- 語調／重音 ${s.prosody}

需要注意的字：
${problems || '（沒有明顯問題的字）'}

請用繁體中文寫出簡短的條列講評，最多 4 行，每行以「• 」開頭：
1. 針對上面分數最低的面向，說明那代表什麼、要怎麼改善
2. 針對需要注意的字，用具體的口腔動作描述怎麼發音（例如「th 要把舌尖輕觸上齒」）
3. 最後一行給一句鼓勵

不要重複列出分數數字，使用者已經看到了。直接講怎麼改善。`;
}

/** 一段講評最多幾行。prompt 裡也寫了 4 行，這裡是模型不聽話時的第二道關。 */
const MAX_NARRATION_LINES = 4;

const BULLET = /^([•‧・*\-–—]|\d+[.)])\s*/;

/**
 * 去掉 markdown 圍欄。模型很愛把整段包進 ```markdown 裡，而那三個反引號
 * 在畫面上就只是雜訊。
 *
 * 抽成獨立的函式是因為情境對話的 AI 修正（server/coach.js）吃的不是條列，
 * 而是「一行一個欄位」的格式 —— 圍欄要拿掉，但條列那一套不適用。
 */
export function stripFences(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/^\s*```[a-z]*\s*\n/i, '')   // 開頭的 ``` 或 ```markdown
    .replace(/\n\s*```\s*$/, '')          // 結尾的圍欄
    .trim();
}

/**
 * 從模型回來的文字裡挑出條列，回傳**不含符號**的字串陣列。
 *
 * 「什麼算一條」的規則刻意只有這一份 —— 講評與情境對話的 AI 修正都在解析
 * 同一批模型的同一種壞習慣（`- ` 而不是「• 」、開場白、只有符號的空行），
 * 各寫一份的話兩邊會慢慢長出不一樣的容忍度。
 */
export function bulletLines(text, max = Infinity) {
  if (typeof text !== 'string') return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    // 只留條列。開場白（「好的，以下是講評：」）與結語都不是條列，會在這裡被丟掉
    .filter((line) => BULLET.test(line))
    // 先把符號拿掉、確認裡面真的有字 ——
    // 順序反過來的話，只有符號的那一行會變成一個空的「• 」留在畫面上
    .map((line) => line.replace(BULLET, '').trim())
    .filter(Boolean)
    .slice(0, max);
}

/**
 * 把模型回來的文字整理成可以直接顯示的講評。整理不出東西時回 null。
 *
 * 為什麼需要它：走 OpenAI 相容端點時拿到的是**純文字**，不是 structured output ——
 * 模型很愛在前面加一句「好的，以下是講評：」、把整段包進 ```markdown 圍欄裡、
 * 或用 `- ` 而不是「• 」開頭。這些在畫面上都是雜訊。
 *
 * 刻意**不**要求 JSON：講評只是幾行字，JSON 除了多一種「回來的不是合法 JSON」
 * 的失敗方式之外沒有任何好處，而且不是每個供應商都支援 JSON mode。
 */
export function cleanNarration(raw) {
  const text = stripFences(raw);
  if (!text) return null;

  const lines = bulletLines(text, MAX_NARRATION_LINES).map((line) => `• ${line}`);
  if (lines.length === 0) return null;
  return lines.join('\n');
}

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
//
// 這幾句**不寫死廠商名**：講評走哪一條路由伺服器的 NARRATION_PROVIDER 決定，
// 可以是 Gemini、也可以是任何 OpenAI 相容端點。寫死的話換過去之後，
// 訊息會叫使用者去看一個根本沒在用的服務。
const CLOSING = {
  disabled: '•（中文講評已關閉，這段是本地摘要。要更具體的建議可以到「設定」重新開啟，' +
    '代價是每次多等幾秒。）',
  no_key: '•（伺服器設定好講評用的模型之後，這裡會換成更具體的中文教練建議）',
  failed: '•（這次的講評沒有回來，已改用本地摘要。分數不受影響，' +
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
