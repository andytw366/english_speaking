// 情境對話的 AI 修正：把使用者寫的那一句送給模型，換回「更自然的說法 + 為什麼」。
//
// ─── 為什麼要有這個 ──────────────────────────────────────────────────────
//
// 情境對話原本的批改是 `public/lib/grade.js`：關鍵字有沒有出現，三級
// （完全相符／意思對了／再想想）。那一套的好處是免費、離線、瞬間，
// 壞處是它**看不懂你寫了什麼** —— 關鍵字都有但文法壞掉會判「意思對了」，
// 用了比參考答案更自然的說法反而可能判「再想想」。
//
// 所以這裡不取代它，是疊在它上面：本地批改與參考答案照樣先出現（免費、即時），
// AI 修正是額外多出來的一段「你這句話本身怎麼樣」。模型沒回來也只是少了那一段。
//
// ─── 為什麼是純文字而不是 JSON ───────────────────────────────────────────
//
// 跟講評同一個理由（見 `server/narration.js`）：兩條路裡只有 Gemini 支援
// structured output，OpenAI 相容端點沒有。要求 JSON 只是多一種
// 「回來的不是合法 JSON」的失敗方式，而**兩條路的格式必須一樣**，
// 不然換模型之後你分不出是模型的差別還是格式的差別。
//
// 換來的代價是要自己解析，而模型會用各種方式不聽話（markdown 粗體、
// 全形冒號、把「修正」寫成「建議」、講評寫成三段散文）。`parseDialogueReview()`
// 就是在收這些，而它是純函式 —— 每一種不聽話都測得到（`test/coach.test.js`）。

import { stripFences, bulletLines } from './narration.js';
import { complete } from './narrator.js';

/** 一次修正最多回幾點說明。prompt 裡也寫了，這裡是模型不聽話時的第二道關。 */
const MAX_NOTES = 3;

/** 修正後的句子最長幾個字元。超過的多半是模型開始寫作文，不是句子。 */
const MAX_CORRECTED_LENGTH = 300;

/** 送出去的欄位各自的長度上限。理由見 `parseReviewRequest()`。 */
export const LIMITS = {
  input: 500,
  reference: 300,
  intent: 200,
  setting: 300,
  role: 60,
  partnerLine: 300,
  accept: 3,
};

/** 判定的三級。**順序有意義**（好 → 壞），前端拿來決定顏色。 */
export const VERDICTS = ['ok', 'minor', 'major'];

/** 模型會寫的中文（與英文）判定字樣 → 我們的三級。 */
const VERDICT_WORDS = [
  [/可以|沒問題|很自然|自然|正確|good|natural|ok\b|fine/i, 'ok'],
  [/小問題|稍微|略|minor|slight/i, 'minor'],
  [/要改|大問題|錯誤|不通|major|wrong|rewrite/i, 'major'],
];

/**
 * 一句台詞的 prompt。**純函式** —— 這是這個功能裡唯一「決定模型看到什麼」的地方。
 *
 * 幾個刻意的決定：
 *
 * - **情境、角色、對方剛剛說的話都要進去。** 少了情境的話，模型只能就句子論句子，
 *   而「Can I get a medium latte to go?」在咖啡店與在藥局是完全不同的評語。
 * - **參考說法要進去，但要明講「不要直接抄」。** 不給的話模型會自己想一句，
 *   跟教材的說法對不上；給了而不講清楚，回來的就永遠是參考說法本身 ——
 *   而那個畫面上已經有了，使用者要知道的是**自己那句**行不行。
 * - **輸出格式寫死成「判定 / 修正 / 條列」**，理由見檔案開頭。
 *
 * @param {{setting_zh?: string, your_role_zh?: string, partner_role_zh?: string,
 *   partner_line?: string, intent_zh?: string, reference?: string,
 *   accept?: string[], input?: string}} task
 */
export function buildDialogueReviewPrompt(task = {}) {
  const {
    setting_zh: setting = '',
    your_role_zh: yourRole = '',
    partner_role_zh: partnerRole = '',
    partner_line: partnerLine = '',
    intent_zh: intent = '',
    reference = '',
    accept = [],
    input = '',
  } = task;

  // 參考說法只列跟主要答案不同的那些 —— accept[0] 通常就是 reference 本身，
  // 重複列一次只是把 prompt 撐長
  const others = accept
    .filter((a) => typeof a === 'string' && a.trim() && a.trim() !== reference.trim())
    .slice(0, LIMITS.accept);

  const lines = [
    '你是一位英語會話老師，正在幫一位母語是繁體中文的台灣學習者批改「情境對話」裡的一句台詞。',
    '',
    setting && `情境：${setting}`,
    yourRole && `學習者扮演：${yourRole}${partnerRole ? `，對方是${partnerRole}` : ''}`,
    partnerLine && `對方剛剛說：「${partnerLine}」`,
    intent && `這一句要表達的意思（中文）：${intent}`,
    reference && `教材的參考說法：「${reference}」`,
    others.length ? `教材接受的其他說法：${others.map((a) => `「${a}」`).join('、')}` : '',
    '',
    `學習者實際寫的是：「${input}」`,
    '',
    '請**完全照下面的格式**回覆，不要加開場白、不要用 markdown 圍欄：',
    '',
    '判定：可以／小問題／要改',
    '修正：<一句英文>',
    '• <繁體中文說明>',
    '• <第二點，可以省略>',
    '',
    '規則：',
    '- 「修正」那一句要**盡量貼近學習者原本的說法，只改必要的地方**。' +
      '不要把教材的參考說法整句抄過來 —— 參考說法他已經看得到了，' +
      '他要知道的是「我自己這樣講行不行」。原句已經自然的話就原句照抄。',
    '- 判定的標準：文法與用字在這個情境下都自然＝可以；意思通但不夠道地或有小錯＝小問題；' +
      '文法錯到會被誤解、或答非所問＝要改。',
    '- 說明用繁體中文（台灣用語），每點一行、最多兩點，講**具體差在哪**' +
      '（哪個字、為什麼母語人士不那樣說）。不要客套話、不要重複整句英文。',
  ];

  return lines.filter((line) => line !== '').join('\n');
}

/**
 * 把模型回來的文字整理成 `{ corrected, verdict, notes }`。整理不出東西時回 null。
 *
 * 「整理不出東西」的定義刻意寬鬆：**只要有修正句或有說明，就算有東西可以顯示**。
 * 兩者都沒有才回 null —— 那時候畫面上會說「這次沒回來」，而本地批改與參考答案
 * 本來就還在，使用者不會卡住。
 *
 * @param {string} raw 模型的原始輸出
 * @param {{ input?: string }} options 沒有判定那一行時，用「有沒有真的改動」推一個
 */
export function parseDialogueReview(raw, { input = '' } = {}) {
  const text = stripFences(raw);
  if (!text) return null;

  const corrected = pickCorrected(text);
  const notes = bulletLines(text, MAX_NOTES)
    // 「修正：…」如果被模型寫成條列的一行，會同時被這裡收走 —— 去掉重複
    .filter((line) => !LABEL.corrected.test(line) && !LABEL.verdict.test(line))
    .map(stripEmphasis)
    .filter(Boolean);

  if (!corrected && notes.length === 0) return null;

  return {
    corrected,
    verdict: pickVerdict(text) ?? inferVerdict(corrected, input),
    notes,
  };
}

/** 兩個欄位的標籤。中英文、全形半形冒號都收 —— 模型每一種都寫得出來。 */
const LABEL = {
  corrected: /^[*_\s]*(修正(後)?(的句子|說法)?|建議(說法)?|更自然的說法|corrected|suggestion|revised)[*_\s]*[:：]/i,
  verdict: /^[*_\s]*(判定|評級|評分|結論|verdict|level)[*_\s]*[:：]/i,
};

/** 去掉 markdown 的粗體／斜體符號 —— 畫面上不會渲染，留著就是幾個星號。 */
function stripEmphasis(line) {
  return line.replace(/[*_`]{1,3}/g, '').trim();
}

/**
 * 找出修正後的那一句。
 *
 * 為什麼要求裡面有英文字母：模型偶爾會寫「修正：無需修正」——
 * 那不是句子，顯示出來只會讓人以為壞了（而「不用改」這件事由判定那一行表達）。
 */
function pickCorrected(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    // 條列符號開頭也要收：模型很愛寫成「- 修正：…」
    const withoutBullet = trimmed.replace(/^([•‧・*\-–—]|\d+[.)])\s*/, '');
    if (!LABEL.corrected.test(withoutBullet)) continue;

    const value = stripEmphasis(withoutBullet.replace(LABEL.corrected, ''))
      // 模型常把句子再包一層引號
      .replace(/^["'「『]|["'」』]$/g, '')
      .trim();
    if (!/[a-z]/i.test(value)) continue;
    return value.slice(0, MAX_CORRECTED_LENGTH);
  }
  return null;
}

function pickVerdict(text) {
  for (const line of text.split('\n')) {
    const withoutBullet = line.trim().replace(/^([•‧・*\-–—]|\d+[.)])\s*/, '');
    if (!LABEL.verdict.test(withoutBullet)) continue;

    const value = withoutBullet.replace(LABEL.verdict, '');
    // 由壞往好比對：模型很愛寫「小問題（意思可以懂）」，那一行同時中
    // 「小問題」與「可以」。先比壞的那幾個才不會把它判成完全沒問題
    for (const [pattern, verdict] of [...VERDICT_WORDS].reverse()) {
      if (pattern.test(value)) return verdict;
    }
  }
  return null;
}

/**
 * 沒有判定那一行時的退路：修正句跟原句一樣就是「可以」，不一樣就是「小問題」。
 *
 * 為什麼不直接給 null 讓畫面留白：判定決定的是那張卡的顏色與標題，
 * 少了它整段會變成一塊沒有結論的文字。而「有改動」這件事本身就是最好的線索。
 */
function inferVerdict(corrected, input) {
  if (!corrected) return 'minor';
  return sameSentence(corrected, input) ? 'ok' : 'minor';
}

/** 只差標點與大小寫的話算同一句 —— 那種差別不值得在畫面上說「改了」。 */
function sameSentence(a, b) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/gi, ' ').trim();
  return norm(a) === norm(b);
}

/**
 * 檢查前端送上來的東西，回一個可以直接餵給 prompt 的 task。
 *
 * 抽成純函式的理由跟 `narration.js` 一樣：`server/index.js` 一 import
 * 就 `app.listen()`，進不了 node:test。而這一層擋的是「一次呼叫要花多少錢」——
 * 沒有上限的話，一個 100 KB 的 input 就是一次很貴的呼叫。
 *
 * 過長**直接截掉而不是回錯誤**：這些欄位都是教材內容或使用者自己打的句子，
 * 正常情況下離上限很遠，會超過就代表有人在亂送 —— 截掉之後模型照樣看得懂，
 * 而錯誤訊息只會讓正常使用者看到一個他無法理解的畫面。唯一會回錯誤的是
 * 「input 是空的」，因為那個是真的沒東西可以改。
 *
 * @returns {{ok: true, task: object} | {ok: false, error: string, message: string}}
 */
export function parseReviewRequest(body = {}) {
  const input = text(body.input, LIMITS.input);
  if (!input) {
    return {
      ok: false,
      error: 'no_input',
      message: '沒有收到你的句子 —— 請先寫下答案再讓 AI 看。',
    };
  }

  const accept = (Array.isArray(body.accept) ? body.accept : [])
    .map((a) => text(a, LIMITS.reference))
    .filter(Boolean)
    .slice(0, LIMITS.accept);

  return {
    ok: true,
    task: {
      input,
      reference: text(body.reference, LIMITS.reference),
      intent_zh: text(body.intent_zh, LIMITS.intent),
      setting_zh: text(body.setting_zh, LIMITS.setting),
      your_role_zh: text(body.your_role_zh, LIMITS.role),
      partner_role_zh: text(body.partner_role_zh, LIMITS.role),
      partner_line: text(body.partner_line, LIMITS.partnerLine),
      accept,
    },
  };
}

function text(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

/**
 * 真的去要一次修正。**失敗一律回 null**（沒設定模型、呼叫失敗、回來的東西
 * 整理不出來，三種都是），呼叫端只要顯示「這次沒回來」就好。
 *
 * @param {object} task `parseReviewRequest()` 的 task
 * @param {{ model?: string, completeImpl?: typeof complete }} options
 *   completeImpl 只給測試用 —— 真正的呼叫在開發容器裡連不出去（見
 *   `server/openai-narrator.js` 開頭）
 */
export async function reviewDialogueAnswer(task, { model, completeImpl = complete } = {}) {
  const raw = await completeImpl(buildDialogueReviewPrompt(task), {
    model,
    // 一句英文加兩行中文。開太大只會讓模型寫成一篇作文，而那不是這裡要的東西
    maxTokens: 300,
  });
  if (!raw) return null;

  const review = parseDialogueReview(raw, { input: task.input });
  if (!review) {
    console.error('[coach] 回應整理不出可用的修正：', String(raw).slice(0, 500));
  }
  return review;
}
