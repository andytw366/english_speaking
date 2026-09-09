// 中文講評的第二條路：任何「OpenAI 相容」的 chat completions 端點。
//
// ─── 為什麼要有這個 ──────────────────────────────────────────────────────
//
// 設定好 Azure 之後，實際練起來唯一有感的等待就是這一段。Azure 的分數、
// 四個面向與逐音素標色一兩秒就出來了，然後對著轉圈圈再等 Gemini 幾秒到十幾秒
// 才看得到中文建議。而這一段做的事其實很小：**把幾個數字寫成四行中文**。
//
// 這種工作換一個快的模型就會快很多。而幾乎所有推論服務都提供 OpenAI 相容的
// `/chat/completions`，所以這裡不綁任何一家 —— base URL、金鑰、model 三個
// 環境變數就能指到 Hugging Face 的 Inference Providers、Groq、Together、
// 或是自己機器上的 Ollama／LM Studio。
//
// ⚠️ **Hugging Face 有兩種端點，選錯會更慢。**
//   - `router.huggingface.co/v1`（Inference Providers）—— 這個才對。它把請求
//     轉給底下的供應商（Groq、Cerebras、Together…），沒有冷啟動。
//   - `api-inference.huggingface.co`（舊的 serverless）—— **不要用**。模型
//     沒被載入時會冷啟動，實測要 20 秒以上，比 Gemini 還慢，換過去等於白換。
//
// ⚠️ **「會先想再答」的 model 要多兩個設定。** gpt-oss、DeepSeek-R1、Qwen 的
// thinking 版這些，想的過程也算在 `max_tokens` 裡 —— 預設的 400 會在它想完之前
// 就用光，回來的 `content` 是空字串，畫面上就只是「講評沒出現」。
// `NARRATION_MAX_TOKENS`（調高額度）與 `NARRATION_REASONING_EFFORT`（少想一點）
// 就是為此而有的，兩個都選填，不設就完全維持原本的行為。
// 撞到的時候伺服器 log 會直接把這三條路寫出來（見 `describeEmptyContent()`）。
//
// ─── 這條路在開發容器裡驗不到 ────────────────────────────────────────────
//
// 容器的 egress 是逐主機允許清單，`huggingface.co`、`api.groq.com`、
// `api.openai.com` 全部連不到（跟 Azure 一樣的處境，見 TODO.md）。
// 所以**真正的呼叫從來沒跑過**。這裡驗過的是：請求的形狀、回應的解析、
// 超時、以及各種錯誤碼對應的中文訊息（`test/narrator.test.js`
// 用假的 fetch 跑）。要驗真的呼叫請看 README「換一個更快的講評模型」。

import { buildNarrationPrompt, cleanNarration } from './narration.js';

/**
 * 講評的逾時。
 *
 * 跟 Gemini 那條路一樣是 20 秒，但意義不同：換到這裡就是為了快，
 * 20 秒是「這條路顯然出事了」的門檻，不是預期的等待時間。
 * 正常情況下這個呼叫應該一兩秒內回來。
 */
const TIMEOUT_MS = 20_000;

/** 講評很短，給足夠寫四行中文的額度就好 —— 上限開太大只會讓模型寫更長。 */
const MAX_TOKENS = 400;

/** `NARRATION_MAX_TOKENS` 收得下的範圍。上界只是別讓人手滑打成一整串數字。 */
const MAX_TOKENS_CEILING = 32_000;

/**
 * 這條路的設定。**前三個**都要有才算設定完成，後兩個是選填的旋鈕。
 *
 * 分成幾個變數而不是一個「provider=groq」的列舉，是因為這樣**不必為了支援
 * 新的供應商改程式碼** —— 換一家就是換 base URL 與 model，跟 App 無關。
 *
 * 後兩個（`NARRATION_MAX_TOKENS`、`NARRATION_REASONING_EFFORT`）是為了
 * 「會先想再答」的 model 才有的，理由見 `describeEmptyContent()`。同樣做成
 * 環境變數而不是寫死在程式碼裡：換一個要想的 model 也還是只改設定，不改 App。
 */
export function openAIConfig() {
  const baseUrl = process.env.NARRATION_BASE_URL?.trim() ?? '';
  const apiKey = process.env.NARRATION_API_KEY?.trim() ?? '';
  const model = process.env.NARRATION_MODEL?.trim() ?? '';
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model,
    maxTokens: parseMaxTokens(process.env.NARRATION_MAX_TOKENS),
    // 小寫化：供應商收的是 low／medium／high，而在設定頁打成 Low 的人
    // 只會得到一個 400，跟「講評沒出現」長得一模一樣
    reasoningEffort: process.env.NARRATION_REASONING_EFFORT?.trim().toLowerCase() ?? '',
  };
}

/** 看不懂就當作沒設定（回 null）—— 但要講出來，不然症狀是「改了卻沒反應」。 */
function parseMaxTokens(raw) {
  const v = String(raw ?? '').trim();
  if (v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TOKENS_CEILING) {
    warnOnce(
      `[narration] NARRATION_MAX_TOKENS="${v}" 不是 1～${MAX_TOKENS_CEILING} 的整數，已忽略`
    );
    return null;
  }
  return n;
}

/**
 * 同一句警告只講一次。
 *
 * `openAIConfig()` 每個請求會被呼叫好幾次（設定頁問一次、真的要打時再問一次），
 * 每次都印的話，一個打錯的值就會把 log 洗到看不到別的東西。
 */
const warned = new Set();
function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/** 設定齊了沒。缺哪一項要講清楚 —— 三個變數少一個的症狀都是「講評沒出現」。 */
export function openAIConfigProblem(config = openAIConfig()) {
  const missing = [
    !config.baseUrl && 'NARRATION_BASE_URL',
    !config.apiKey && 'NARRATION_API_KEY',
    !config.model && 'NARRATION_MODEL',
  ].filter(Boolean);
  if (missing.length === 0) return null;
  return `還缺 ${missing.join('、')}`;
}

export function hasOpenAIConfig() {
  return openAIConfigProblem() === null;
}

/**
 * 呼叫 OpenAI 相容端點，把模型回來的**原始文字**交出去。
 *
 * 為什麼是「原始文字」而不是整理好的講評：這條路現在有兩個用途 ——
 * 跟讀的中文講評（條列）與情境對話的 AI 修正（一行一個欄位，見 `server/coach.js`）。
 * 兩者要的整理方式不一樣，但**請求怎麼發、超時怎麼算、哪個狀態碼代表什麼**
 * 完全一樣。那一段只放這裡一份，換供應商時要改的地方才只有一個。
 *
 * 跟 `narrateAssessment()` 一樣：**失敗一律回 null，不丟例外**。
 * 模型的輸出是配角（Azure 的分數、本地批改才是主角），呼叫端拿到 null
 * 就改用不花錢的那條路。
 *
 * @param {string} prompt 要送出去的提示（prompt 一律由呼叫端組，不在這裡組）
 * @param {{ maxTokens?: number, temperature?: number, timeoutMs?: number,
 *   fetchImpl?: typeof fetch }} options fetchImpl 只給測試用
 */
export async function completeViaOpenAI(prompt, {
  maxTokens = MAX_TOKENS,
  temperature = 0.3,
  timeoutMs = TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const config = openAIConfig();
  const problem = openAIConfigProblem(config);
  if (problem) {
    console.error(`[narration] OpenAI 相容端點的設定不完整：${problem}`);
    return null;
  }

  // `NARRATION_MAX_TOKENS` **蓋掉呼叫端要的額度**，不是取大的那一個。
  //
  // 呼叫端填的數字（講評 400、AI 修正 300）算的是「答案有多長」，而會先想再答的
  // model 是把想的過程也記在同一個額度裡 —— 兩個用途都會不夠，所以這個旋鈕
  // 一設就是兩條路一起調。不需要想的 model 就別設它，維持呼叫端自己的判斷。
  const budget = config.maxTokens ?? maxTokens;

  // 用 AbortController 而不是 Promise.race：race 贏了之後那個請求還是掛在背景
  // 跑完才放掉連線，連續超時幾次就會累積一堆沒人要的請求。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: budget,
        // 不需要創意，要的是穩定 —— 同樣的輸入每次講差不多的話才好比較
        temperature,
        stream: false,
        // **只有設定了才送。** 不會推理的 model 收到不認得的參數多半直接回 400，
        // 而那個 400 的症狀跟金鑰打錯一模一樣（講評沒出現）。預設不送，
        // 就不會有人為了一個他根本用不到的參數去查半天。
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // 完整內容只寫進伺服器 log。金鑰不會出現在回應裡，但錯誤訊息可能含端點細節
      const body = await res.text().catch(() => '');
      console.error(
        `[narration] ${config.baseUrl} 回了 ${res.status}` +
          `${describeStatus(res.status)}：${body.slice(0, 500)}`
      );
      return null;
    }

    const data = await res.json();
    // OpenAI 相容的形狀就是這一個；有些供應商會多包東西，但 choices[0] 是共同點
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      console.error(
        '[narration] 回應裡找不到文字內容：',
        JSON.stringify(data)?.slice(0, 500)
      );
      const hint = describeEmptyContent(choice, budget);
      if (hint) console.error(hint);
      return null;
    }
    return content;
  } catch (err) {
    if (err?.name === 'AbortError') {
      console.error(`[narration] ${config.model} 超過 ${timeoutMs / 1000} 秒沒回應，改用不呼叫模型的那條路`);
    } else {
      console.error('[narration] 呼叫 OpenAI 相容端點失敗：', err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 呼叫 OpenAI 相容端點產生中文講評。整理不出東西時回 null（呼叫端改用本地摘要）。
 *
 * @param {object} assessment assessPronunciation() 的回傳值
 * @param {{ fetchImpl?: typeof fetch }} options fetchImpl 只給測試用
 */
export async function narrateViaOpenAI(assessment, { fetchImpl = fetch } = {}) {
  const raw = await completeViaOpenAI(buildNarrationPrompt(assessment), { fetchImpl });
  const cleaned = cleanNarration(raw);
  if (raw && !cleaned) {
    console.error('[narration] 回應裡找不到可用的講評：', raw.slice(0, 500));
  }
  return cleaned;
}

/**
 * 「200 但一個字都沒有」的提示。
 *
 * 這是換到「會先想再答」的 model（gpt-oss、DeepSeek-R1、Qwen 的 thinking 版…）
 * 最容易撞到、也最難自己看出來的一種失敗：HTTP 是 200、金鑰沒問題、端點沒問題，
 * 但 `content` 是空字串，畫面上就只是「講評沒出現」。
 *
 * 原因是**想的過程也算在 `max_tokens` 裡**。額度 400 對四行中文很夠，
 * 對「先想三百字再寫四行」完全不夠 —— 額度在想完之前就用光，正式的答案
 * 一個字都還沒輪到。所以這裡不只說「找不到文字」，還要說怎麼修。
 *
 * @param {object} choice 回應裡的 choices[0]
 * @param {number} maxTokens 這次真的送出去的額度
 */
function describeEmptyContent(choice, maxTokens) {
  // reasoning 放哪個欄位各家不一樣（Groq 是 reasoning，另一些是 reasoning_content），
  // 兩個都看一下；finish_reason=length 則是「話沒講完就被截斷」的共同訊號
  const reasoning = choice?.message?.reasoning ?? choice?.message?.reasoning_content;
  const truncated = choice?.finish_reason === 'length';
  if (!reasoning && !truncated) return '';

  return (
    '[narration] 這看起來是「會先想再答」的 model：' +
    (reasoning ? '回應裡有 reasoning 欄位' : 'finish_reason 是 length') +
    `，而想的過程也算在 max_tokens=${maxTokens} 裡，額度在它想完之前就用光了。三條路：\n` +
    '  1. NARRATION_MAX_TOKENS 調高（1200 起跳）\n' +
    '  2. NARRATION_REASONING_EFFORT=low（要供應商支援才有用）\n' +
    '  3. 換一個不推理的 model —— 講評只是把幾個數字寫成四行中文，本來就不需要推理'
  );
}

/** 常見錯誤碼的提示。只寫進伺服器 log，給設定的人看的。 */
function describeStatus(status) {
  switch (status) {
    case 400:
    case 422:
      // 換到會推理的 model 之前，這個狀態碼幾乎只會來自打錯的 model id；
      // 之後最常見的來源是 reasoning_effort 送給了一個不吃它的 model
      return '（端點看不懂這個請求 —— 有填 NARRATION_REASONING_EFFORT 的話先清掉，' +
        '不會推理的 model 收到這個參數就是回這個；再來檢查 NARRATION_MODEL 拼對沒）';
    case 401:
    case 403:
      return '（金鑰無效或沒有這個 model 的權限 —— 檢查 NARRATION_API_KEY）';
    case 404:
      return '（找不到端點或 model —— NARRATION_BASE_URL 結尾要是 /v1，' +
        'NARRATION_MODEL 要照供應商列的 id 完整填）';
    case 429:
      return '（超過用量限制）';
    case 503:
      return '（供應商暫時無法服務；若用的是舊的 api-inference 端點，' +
        '這通常是模型冷啟動 —— 換成 router.huggingface.co/v1）';
    default:
      return '';
  }
}
