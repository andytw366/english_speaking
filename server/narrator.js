// 中文講評要走哪一條路。**選擇邏輯只有這一份。**
//
// 為什麼要獨立出來：講評現在有三種可能的來源（Gemini、任何 OpenAI 相容端點、
// 本地摘要），而「現在用的是哪一個」這個問題有三個地方要問 ——
// `/api/capabilities`（設定頁要顯示）、`/api/pronunciation-feedback`（真的要呼叫）、
// 以及伺服器啟動時的提示。三個地方各判斷一次的話，一定會有一天對不起來，
// 而症狀是「設定頁說在用 A，實際跑的是 B」。
//
// 選法刻意很笨：`NARRATION_PROVIDER` 說了算，沒說就看誰的設定是齊的。
// **不做自動 fallback**（openai 失敗就改打 Gemini）—— 那會讓「我明明換成快的了，
// 怎麼還是要等十幾秒」變成無解的問題。設定的那條路失敗就退回本地摘要，
// 使用者馬上看得出來，也知道要去修哪裡。

import { narrateAssessment, hasApiKey } from './gemini.js';
import { hasOpenAIConfig, narrateViaOpenAI, openAIConfig, openAIConfigProblem } from './openai-narrator.js';

/** 可以填在 NARRATION_PROVIDER 的值。 */
export const PROVIDERS = ['gemini', 'openai', 'local'];

/**
 * 現在講評走哪一條路，以及為什麼。
 *
 * @returns {{id: 'gemini'|'openai'|'local', label: string, model: string,
 *   ready: boolean, problem: string|null}}
 *   ready=false 代表這條路被選中了但設定不完整 —— 這種情況會退回本地摘要，
 *   而 problem 就是要顯示給使用者看的原因。
 */
export function narrationProvider() {
  const requested = process.env.NARRATION_PROVIDER?.trim().toLowerCase();

  if (requested && !PROVIDERS.includes(requested)) {
    console.warn(
      `[narration] .env 的 NARRATION_PROVIDER="${requested}" 不認得，` +
        `改用自動判斷。可以填的是：${PROVIDERS.join(' / ')}`
    );
  }

  const chosen = PROVIDERS.includes(requested) ? requested : autoDetect();

  if (chosen === 'local') {
    return { id: 'local', label: '本地摘要', model: '', ready: true, problem: null };
  }

  if (chosen === 'openai') {
    const config = openAIConfig();
    const problem = openAIConfigProblem(config);
    return {
      id: 'openai',
      // 顯示主機名而不是完整 URL：設定頁上「router.huggingface.co」一眼看得懂，
      // 完整 URL 只是把版面撐開
      label: config.baseUrl ? hostOf(config.baseUrl) : 'OpenAI 相容端點',
      model: config.model,
      ready: !problem,
      problem,
    };
  }

  return {
    id: 'gemini',
    label: 'Gemini',
    model: '',
    ready: hasApiKey(),
    problem: hasApiKey() ? null : '還缺 GEMINI_API_KEY',
  };
}

/** 沒指定時：設定齊了的那一個優先，兩個都齊就用 Gemini（原本的行為）。 */
function autoDetect() {
  if (hasApiKey()) return 'gemini';
  if (hasOpenAIConfig()) return 'openai';
  return 'gemini'; // 兩個都沒有時仍回 gemini，讓 ready=false 的原因講得具體
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 產生中文講評。**失敗一律回 null**，呼叫端改用本地摘要。
 *
 * @param {object} assessment assessPronunciation() 的回傳值
 * @param {{ model?: string }} options model 只有 Gemini 那條路用得到
 *   （前端的 model 選單是 Gemini 專屬的；OpenAI 那條路的 model 在 .env 裡，
 *   因為它是「這台伺服器接到哪個服務」，不是使用者每次練習要挑的東西）
 */
export async function narrate(assessment, { model } = {}) {
  const provider = narrationProvider();

  if (provider.id === 'local') return null;
  if (!provider.ready) {
    console.error(`[narration] ${provider.label} ${provider.problem}，改用本地摘要`);
    return null;
  }

  if (provider.id === 'openai') return narrateViaOpenAI(assessment);
  return narrateAssessment(assessment, { model });
}
