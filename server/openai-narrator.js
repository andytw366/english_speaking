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
// ─── 這條路在開發容器裡驗不到 ────────────────────────────────────────────
//
// 容器的 egress 是逐主機允許清單，`huggingface.co`、`api.groq.com`、
// `api.openai.com` 全部連不到（跟 Azure 一樣的處境，見 TODO.md）。
// 所以**真正的呼叫從來沒跑過**。這裡驗過的是：請求的形狀、回應的解析、
// 超時、以及各種錯誤碼對應的中文訊息（`test/openai-narrator.test.js`
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

/**
 * 這條路的設定。三個都要有才算設定完成。
 *
 * 分成三個變數而不是一個「provider=groq」的列舉，是因為這樣**不必為了支援
 * 新的供應商改程式碼** —— 換一家就是換 base URL 與 model，跟 App 無關。
 */
export function openAIConfig() {
  const baseUrl = process.env.NARRATION_BASE_URL?.trim() ?? '';
  const apiKey = process.env.NARRATION_API_KEY?.trim() ?? '';
  const model = process.env.NARRATION_MODEL?.trim() ?? '';
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model };
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
 * 呼叫 OpenAI 相容端點產生中文講評。
 *
 * 跟 `narrateAssessment()` 一樣：**失敗一律回 null，不丟例外**。
 * 講評是配角，Azure 的分數才是主角 —— 呼叫端拿到 null 就改用本地摘要，
 * 分數照樣看得到。
 *
 * @param {object} assessment assessPronunciation() 的回傳值
 * @param {{ fetchImpl?: typeof fetch }} options fetchImpl 只給測試用
 */
export async function narrateViaOpenAI(assessment, { fetchImpl = fetch } = {}) {
  const config = openAIConfig();
  const problem = openAIConfigProblem(config);
  if (problem) {
    console.error(`[narration] OpenAI 相容端點的設定不完整：${problem}`);
    return null;
  }

  // 用 AbortController 而不是 Promise.race：race 贏了之後那個請求還是掛在背景
  // 跑完才放掉連線，連續超時幾次就會累積一堆沒人要的請求。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: buildNarrationPrompt(assessment) }],
        max_tokens: MAX_TOKENS,
        // 講評不需要創意，要的是穩定 —— 同樣的分數每次講差不多的話才好比較
        temperature: 0.3,
        stream: false,
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
    const content = data?.choices?.[0]?.message?.content;
    const cleaned = cleanNarration(content);
    if (!cleaned) {
      console.error(
        '[narration] 回應裡找不到可用的講評：',
        JSON.stringify(data)?.slice(0, 500)
      );
    }
    return cleaned;
  } catch (err) {
    if (err?.name === 'AbortError') {
      console.error(`[narration] ${config.model} 超過 ${TIMEOUT_MS / 1000} 秒沒回應，改用本地摘要`);
    } else {
      console.error('[narration] 呼叫 OpenAI 相容端點失敗（將改用本地摘要）：', err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 常見錯誤碼的提示。只寫進伺服器 log，給設定的人看的。 */
function describeStatus(status) {
  switch (status) {
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
