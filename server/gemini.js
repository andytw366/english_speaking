import { GoogleGenAI } from '@google/genai';

// §2.1：SDK 已改成 Interactions API，音訊 part 的欄位是 snake_case 的 mime_type。
// 這裡的形狀有對照 node_modules/@google/genai 的型別定義確認過：
//   - 音訊 part：{ type: "audio", data, mime_type }
//   - AudioContentMimeType 明確包含 "audio/wav"，且完全沒有 "audio/webm"
//     （這也是為什麼前端一律先轉成 WAV，見 public/wav-encoder.js）
//   - response_format：{ type: "text", mime_type: "application/json", schema }
//   - 回覆用 interaction.output_text

const MODEL = 'gemini-3.6-flash';
const TIMEOUT_MS = 60_000;

// 階段 4：讓 Gemini 一次回傳 transcript + 分數 + 講評，
// 取代原本要用 Web Speech API 做辨識的規劃（SpeechRecognition 吃不了錄好的 Blob）。
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    transcript: {
      type: 'string',
      description: '你實際聽到使用者唸出來的英文內容，逐字照實寫，不要自動修正成目標句。',
    },
    score: {
      type: 'integer',
      description: '0-100 的發音參考分數，考量準確度、語調與流暢度。',
    },
    problem_words: {
      type: 'array',
      items: { type: 'string' },
      description: '發音明顯不準確的英文單字，取自目標句，最多 5 個。沒有就給空陣列。',
    },
    feedback_zh: {
      type: 'string',
      description: '繁體中文的簡短條列講評，每行以「• 」開頭。',
    },
  },
  required: ['transcript', 'score', 'problem_words', 'feedback_zh'],
};

function buildPrompt(sentence) {
  return `你是一位英語發音教練。使用者嘗試唸的句子是：「${sentence}」

請聽附上的錄音，用繁體中文具體指出：
1. 哪些字的發音不準確
2. 語調／重音是否自然
3. 一句鼓勵 + 一個具體可改善的建議

請用簡短條列回答，不要長篇大論。

另外請一併提供：
- transcript：你實際聽到的英文內容，逐字照實記錄。如果使用者唸錯、漏字或多唸，
  就照實寫下你聽到的，不要自動修正成上面的目標句 —— 這個欄位會拿去跟目標句做比對。
- score：0-100 的發音參考分數
- problem_words：發音明顯不準的單字（取自目標句）

如果錄音裡幾乎聽不到人聲，或內容與目標句完全無關，
請把 score 設為 0、transcript 設為你實際聽到的（或空字串），
並在 feedback_zh 說明沒有聽清楚，請使用者重錄。`;
}

let client = null;
function getClient() {
  // SDK 預設會讀 process.env.GEMINI_API_KEY
  if (!client) client = new GoogleGenAI({});
  return client;
}

/** 呼叫端可以據此決定 HTTP 狀態碼與要給使用者看的中文訊息。 */
export class GeminiError extends Error {
  constructor(code, httpStatus, userMessage, cause) {
    super(userMessage);
    this.name = 'GeminiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.userMessage = userMessage;
    this.cause = cause;
  }
}

export function hasApiKey() {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

// Google AI Studio 的金鑰都是 AIza 開頭。先做個格式檢查，
// 這樣「忘了把 .env 裡的 your-api-key-here 換掉」這種最常見的狀況
// 可以直接給明確訊息，不用等 API 回一個含糊的 400。
function looksLikeApiKey(key) {
  return /^AIza[\w-]{20,}$/.test(key);
}

/**
 * 把錄音送給 Gemini，取得結構化的發音講評。
 * @param {{ audioBuffer: Buffer, mimeType: string, sentence: string }} args
 * @returns {Promise<{transcript: string, score: number, problem_words: string[], feedback_zh: string}>}
 */
export async function getPronunciationFeedback({ audioBuffer, mimeType, sentence }) {
  if (!hasApiKey()) {
    throw new GeminiError(
      'missing_api_key',
      500,
      '伺服器沒有設定 Gemini API 金鑰。請在專案根目錄建立 .env，' +
        '填入 GEMINI_API_KEY=你的金鑰，然後重新啟動伺服器。'
    );
  }

  if (!looksLikeApiKey(process.env.GEMINI_API_KEY.trim())) {
    throw new GeminiError(
      'malformed_api_key',
      401,
      '.env 裡的 GEMINI_API_KEY 看起來不是有效的金鑰' +
        '（Google AI Studio 的金鑰是 AIza 開頭的一長串）。' +
        '請確認你已經把範例值換成真正的金鑰，改完要重新啟動伺服器。' +
        '金鑰申請：https://aistudio.google.com/apikey'
    );
  }

  const ai = getClient();

  let interaction;
  try {
    interaction = await withTimeout(
      ai.interactions.create({
        model: MODEL,
        input: [
          { type: 'text', text: buildPrompt(sentence) },
          {
            type: 'audio',
            data: audioBuffer.toString('base64'),
            mime_type: mimeType,
          },
        ],
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: RESPONSE_SCHEMA,
        },
      }),
      TIMEOUT_MS
    );
  } catch (err) {
    throw classifyError(err);
  }

  const raw = interaction?.output_text;
  if (!raw) {
    console.error('[gemini] 回覆沒有 output_text：', JSON.stringify(interaction)?.slice(0, 800));
    throw new GeminiError(
      'empty_response',
      502,
      'Gemini 沒有回傳任何內容，請再試一次。'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error('[gemini] output_text 不是合法 JSON：', raw.slice(0, 800));
    throw new GeminiError(
      'bad_json',
      502,
      'Gemini 回傳的格式不正確，請再試一次。',
      err
    );
  }

  return normalize(parsed);
}

/** 就算 schema 有指定，仍然防禦性地檢查一次，避免壞資料流到前端。 */
function normalize(parsed) {
  const score = Number(parsed.score);
  return {
    transcript: typeof parsed.transcript === 'string' ? parsed.transcript : '',
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null,
    problem_words: Array.isArray(parsed.problem_words)
      ? parsed.problem_words.filter((w) => typeof w === 'string').slice(0, 5)
      : [],
    feedback_zh:
      typeof parsed.feedback_zh === 'string' && parsed.feedback_zh.trim()
        ? parsed.feedback_zh
        : '（Gemini 沒有給出講評內容，請再試一次）',
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Gemini 呼叫超過 ${ms / 1000} 秒`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 把 SDK 的錯誤對應成各自不同的中文訊息。
 * 踩雷清單 #10：完整錯誤只寫進伺服器 log，回給前端的訊息不含金鑰或 stack。
 */
function classifyError(err) {
  // 完整錯誤留在伺服器端方便除錯
  console.error('[gemini] 呼叫失敗：', err);

  if (err?.code === 'ETIMEDOUT') {
    return new GeminiError(
      'timeout',
      504,
      'Gemini 回應逾時。可能是網路不穩或錄音太長，請縮短錄音後再試一次。',
      err
    );
  }

  const status = Number(err?.status);
  const message = String(err?.message ?? '');

  switch (status) {
    case 400:
      // 實測：金鑰無效時 Gemini 也是回 400（不是 401/403），
      // 而且 SDK 的錯誤訊息裡看不到 API_KEY_INVALID 這個原因。
      // 所以這裡兩種可能都要講，不能只說音檔格式有問題。
      return new GeminiError(
        'bad_request',
        400,
        'Gemini 拒絕了這個請求（400）。最常見的原因是 API 金鑰無效 —— ' +
          '請先確認 .env 裡的 GEMINI_API_KEY 是有效的（到 https://aistudio.google.com/apikey 確認）。' +
          '若金鑰確定沒問題，就可能是音檔內容的問題，請重新錄一次。' +
          '完整錯誤在伺服器 console。',
        err
      );
    case 401:
    case 403:
      return new GeminiError(
        'invalid_key',
        401,
        'Gemini API 金鑰無效或沒有權限。請確認 .env 裡的 GEMINI_API_KEY 填對了' +
          '（到 https://aistudio.google.com/apikey 重新產生一組），改完要重新啟動伺服器。',
        err
      );
    case 429:
      return new GeminiError(
        'rate_limited',
        429,
        '已達 Gemini API 的用量上限（免費層有每分鐘／每日的請求限制）。' +
          '請等一分鐘再試，或到 Google AI Studio 查看你的配額。',
        err
      );
    case 500:
    case 502:
    case 503:
      return new GeminiError(
        'upstream_error',
        502,
        'Gemini 服務暫時有問題，請稍等一下再試一次。',
        err
      );
  }

  // 連不到 Google
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(message)) {
    return new GeminiError(
      'network',
      502,
      '連不到 Gemini 服務，請確認這台機器可以連上網路後再試一次。',
      err
    );
  }

  return new GeminiError(
    'unknown',
    500,
    '呼叫 Gemini 時發生非預期的錯誤，詳細原因請看伺服器 console。',
    err
  );
}
