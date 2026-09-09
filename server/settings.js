import fs from 'node:fs';
import path from 'node:path';

import { PROVIDERS } from './narrator.js';
import { parseLimit, parseLimits } from './quota.js';

// 從瀏覽器設定 API 金鑰。
//
// ─── 安全邊界（有帳號之後換過一次）─────────────────────────────────────────
//
// 以前：**只放行 loopback**（127.0.0.1 / ::1）。那時候後端零認證，這是唯一
//   擋得住「路過的人改你的金鑰」的方法。代價是走 Docker／網域的部署一律 403
//   —— 請求從 Caddy 的容器 IP 進來，不是 127.0.0.1 —— 所以手機上根本設不了，
//   只能 ssh 進去編輯 .env 再重啟。
//
// 現在：**要登入 + 要是擁有者 + POST 要過 Origin 檢查**。
//   登入與 Origin 是 `server/routes-auth.js` 的 authGate 做的（所有 /api 都有），
//   擁有者這一關是下面的 `assertOwner()`。
//
// 為什麼可以放寬：loopback 擋的是「任何連得到的人都能寫 .env」，而現在
// 走得到這個端點的前提是有帳號、有 session cookie。
// 為什麼**不能只靠 authGate**：`INVITE_CODE` 開著的時候家裡其他人也有帳號，
// 而金鑰是會花錢的東西 —— 只有擁有者（第一個註冊的帳號）能碰。
//
// ─── 寫到哪 ──────────────────────────────────────────────────────────────
//
// `<DATA_DIR>/settings.env`，**不是**專案根目錄的 `.env`。三個理由：
//   1. Docker 裡 `/app` 是 root 的，容器跑的是 node 使用者 —— 寫 `.env` 會
//      EACCES。而 Docker 正是最需要「從網頁設定」的部署方式；
//   2. 就算寫得進去，`docker compose up --build` 一次就沒了。`DATA_DIR` 有掛
//      volume，跟帳號與學習進度一起留著；
//   3. `.env` 是人手寫的（一堆註解與 Docker 那幾段），程式不去動它比較不會搞爛。
//
// 讀的順序在 `server/index.js`：先 `.env`，再 `settings.env`（override）。
// 從網頁存的值是後來的、也是刻意的，所以它蓋掉 `.env` 與 compose 傳進來的環境變數
// —— 反過來的話「在網頁上改了金鑰卻沒有任何反應」，而且畫面上看不出原因。

/** 可以從設定頁改的變數。**不在這份清單裡的一律忽略**，不是回錯誤。 */
const MANAGED_KEYS = [
  'AZURE_SPEECH_KEY',
  'AZURE_SPEECH_REGION',
  'GEMINI_API_KEY',
  'NARRATION_PROVIDER',
  'NARRATION_BASE_URL',
  'NARRATION_API_KEY',
  'NARRATION_MODEL',
  // 給「會先想再答」的 model 用的兩個旋鈕（選填，見 server/openai-narrator.js）。
  // 放進來的理由跟 model 一樣：撞到「講評整段消失」的時候人多半在手機上，
  // 而修法是改一個數字 —— 為了改一個數字 ssh 進伺服器太蠢了
  'NARRATION_MAX_TOKENS',
  'NARRATION_REASONING_EFFORT',
  // 每天的呼叫上限（所有模式一起算）。跟金鑰放同一條路是刻意的 ——
  // 它跟金鑰一樣是「會花錢的設定」，而且改它的時機正是「發現花太兇」的時候，
  // 那時候人多半在手機上，不會想 ssh 進伺服器改 .env
  'AI_DAILY_LIMIT',
  'AI_DAILY_LIMITS',
];

/** 值的長度上限。正常的金鑰不到 200 字元，這只是別讓人塞一整個檔案進來。 */
const MAX_VALUE_LENGTH = 500;

export const SETTINGS_FILENAME = 'settings.env';

export function settingsPath(dataDir) {
  return path.join(dataDir, SETTINGS_FILENAME);
}

export class SettingsError extends Error {
  constructor(httpStatus, userMessage) {
    super(userMessage);
    this.httpStatus = httpStatus;
    this.userMessage = userMessage;
  }
}

/**
 * 只有擁有者可以讀寫金鑰設定。
 *
 * 純函式（吃兩個使用者物件，不碰 req）—— 這一層寫錯的代價是「別人可以改你的
 * 金鑰」，而錯了不會有徵兆，所以刻意做成測得到的形狀（test/settings-server.test.js）。
 *
 * @param {{id: string}|null|undefined} user   這個請求是誰（authGate 放進 req.user）
 * @param {{id: string, username?: string}|null|undefined} owner 第一個註冊的帳號
 */
export function assertOwner(user, owner) {
  // 正常情況下 authGate 已經擋掉沒登入的了，這裡是第二道 ——
  // 端點掛錯位置（掛在 authGate 之前）時，這一行是唯一擋得住的東西
  if (!user) {
    throw new SettingsError(401, '請先登入。');
  }
  if (!owner) {
    throw new SettingsError(403, '這台伺服器還沒有擁有者，無法修改金鑰設定。');
  }
  if (user.id !== owner.id) {
    throw new SettingsError(
      403,
      `只有擁有者可以修改金鑰設定 —— 也就是這台伺服器上第一個註冊的帳號` +
        `${owner.username ? `（${owner.username}）` : ''}。\n` +
        '金鑰是會花錢的東西（Azure 與講評的配額），所以不跟著邀請碼一起開放。'
    );
  }
}

/** 只回報「有沒有設定」與末四碼，永遠不回傳完整金鑰。 */
function mask(value) {
  if (!value) return { configured: false, preview: '' };
  const v = String(value);
  return {
    configured: true,
    preview: v.length <= 4 ? '••••' : `••••${v.slice(-4)}`,
  };
}

/** 不是機密的值（區域、端點、model 名稱）直接回完整值，設定頁要顯示它。 */
function plain(value) {
  const v = value?.trim() ?? '';
  return { configured: Boolean(v), value: v };
}

export function readSettings() {
  return {
    AZURE_SPEECH_KEY: mask(process.env.AZURE_SPEECH_KEY?.trim()),
    AZURE_SPEECH_REGION: plain(process.env.AZURE_SPEECH_REGION),
    GEMINI_API_KEY: mask(process.env.GEMINI_API_KEY?.trim()),
    // 講評走哪一條路的幾個變數。金鑰以外都不是機密 ——
    // 而「現在指到哪個端點、哪個 model、送了什麼參數」是換模型時唯一能自己查的東西
    NARRATION_PROVIDER: plain(process.env.NARRATION_PROVIDER),
    NARRATION_BASE_URL: plain(process.env.NARRATION_BASE_URL),
    NARRATION_API_KEY: mask(process.env.NARRATION_API_KEY?.trim()),
    NARRATION_MODEL: plain(process.env.NARRATION_MODEL),
    NARRATION_MAX_TOKENS: plain(process.env.NARRATION_MAX_TOKENS),
    NARRATION_REASONING_EFFORT: plain(process.env.NARRATION_REASONING_EFFORT),
    // 呼叫上限不是機密，而且「現在的上限是多少」正是使用者要在畫面上看到的東西
    AI_DAILY_LIMIT: plain(process.env.AI_DAILY_LIMIT),
    AI_DAILY_LIMITS: plain(process.env.AI_DAILY_LIMITS),
  };
}

/**
 * 一個值合不合法。回問題描述，沒問題回 null。
 *
 * 為什麼要驗：這些值存下去之後只會在「送出一次錄音」時才用到，
 * 而錯的症狀是「講評沒出現」或「認證失敗」—— 離設定的動作很遠。
 * 在按下儲存的當下就講清楚，比事後翻伺服器 log 便宜得多。
 */
export function valueProblem(key, value) {
  const v = String(value ?? '');
  if (/[\r\n]/.test(v)) return `${key} 不能包含換行。請確認貼上的內容正確。`;
  if (v.length > MAX_VALUE_LENGTH) return `${key} 太長了（上限 ${MAX_VALUE_LENGTH} 個字元）。`;
  if (v === '') return null;   // 空字串是「清除這一項」，一律合法

  // 單引號是我們寫檔時的引號（見 formatEnvValue），值裡有它就沒辦法安全地寫出去。
  // 在這裡擋而不是在寫檔的時候擋 —— 所有檢查在同一個地方做完，
  // 才不會出現「有幾個變數已經寫進去了，第三個才失敗」
  if (v.includes("'")) return `${key} 不能包含單引號（'）。請確認貼上的內容正確。`;

  if (key === 'AZURE_SPEECH_REGION') {
    // Azure 的區域是小寫英數，例如 eastasia、japaneast。
    // 貼成「East Asia」或整個端點 URL 是最常見的錯法，而症狀是認證失敗
    if (!/^[a-z0-9-]+$/.test(v)) {
      return 'Azure 區域只能是小寫英數字，例如 eastasia、japaneast、westus。' +
        '（不是「East Asia」，也不是完整的端點網址。）';
    }
  }

  if (key === 'NARRATION_PROVIDER' && !PROVIDERS.includes(v)) {
    return `講評來源只能填 ${PROVIDERS.join(' / ')}，留空表示自動判斷。`;
  }

  // 這兩個是選填的，但填錯的症狀特別難認：max_tokens 打成 0 或
  // reasoning_effort 打成一句話，端點回的是 400，而畫面上跟金鑰錯了一模一樣
  if (key === 'NARRATION_MAX_TOKENS') {
    const n = Number(v);
    if (!/^\d+$/.test(v) || !Number.isInteger(n) || n < 1 || n > 32000) {
      return '單次回應的 token 上限要填 1 到 32000 之間的整數，留空是用預設值（400）。' +
        '會先想再答的 model（gpt-oss 這類）建議 1200 起跳 —— 想的過程也算在這個額度裡。';
    }
  }

  if (key === 'NARRATION_REASONING_EFFORT' && !/^[A-Za-z]+$/.test(v)) {
    // 不寫死 low/medium/high 的白名單：各家收的值不一樣（有的還有 minimal、none），
    // 寫死的話下一個供應商多一個值就得改程式碼，而這裡本來就是為了不用改程式碼
    return 'reasoning_effort 只能填一個英文單字（常見的是 low / medium / high），' +
      '留空表示不送這個參數 —— 不會推理的 model 收到它會直接回 400。';
  }

  if (key === 'AI_DAILY_LIMIT' && parseLimit(v) === undefined) {
    return '每天的呼叫上限要填一個數字（例如 200），或填 off 表示不限制。留空是用預設值。';
  }

  if (key === 'AI_DAILY_LIMITS') {
    // 空的結果代表「一條都沒看懂」——parseLimits 對看不懂的項目是略過，
    // 所以打錯字的症狀會是「存好了，但上限沒有變」。在這裡就講清楚
    if (Object.keys(parseLimits(v)).length === 0) {
      return '逐模型的上限要寫成「model=次數」，多個用分號隔開，' +
        '例如 gemini=50; openai/gpt-oss-120b:groq=500。次數可以填 off 表示不限制。';
    }
  }

  if (key === 'NARRATION_BASE_URL') {
    let url;
    try {
      url = new URL(v);
    } catch {
      return '講評端點要是完整網址，例如 https://router.huggingface.co/v1。';
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return '講評端點只能是 http 或 https。';
    }
    // 我們自己會接上 /chat/completions，連著填會變成 …/chat/completions/chat/completions
    if (/\/chat\/completions\/?$/.test(url.pathname)) {
      return '講評端點只要填到 /v1，不要含 /chat/completions —— 那一段伺服器會自己接。';
    }
  }

  return null;
}

/**
 * 寫進 `<DATA_DIR>/settings.env`。檔案裡其他內容（註解、別的變數）原樣保留。
 * 值傳空字串代表清除該設定。
 *
 * @param {string} dataDir DATA_DIR（帳號與進度放的那個目錄）
 * @param {Record<string, string>} updates
 * @returns {string[]} 真的寫進去的變數名
 */
export function writeSettings(dataDir, updates) {
  const file = settingsPath(dataDir);

  const clean = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!MANAGED_KEYS.includes(key)) continue;
    const v = String(value ?? '').trim();
    const problem = valueProblem(key, v);
    if (problem) throw new SettingsError(400, problem);
    clean[key] = v;
  }

  if (Object.keys(clean).length === 0) {
    throw new SettingsError(400, '沒有可更新的設定項目。');
  }

  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    lines = [
      '# 由設定頁面寫的。這個檔案在 DATA_DIR 裡（跟帳號與學習進度一起），',
      '# 而且會蓋掉專案根目錄 .env 與環境變數裡的同名設定。',
    ];
  }

  const seen = new Set();
  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!m || !(m[1] in clean)) return line;
    seen.add(m[1]);
    return `${m[1]}=${formatEnvValue(clean[m[1]])}`;
  });

  // 先去掉結尾空行，再追加新變數 —— 否則新的一行會被原本檔尾的空行隔開
  while (next.length && next[next.length - 1].trim() === '') next.pop();

  for (const [key, value] of Object.entries(clean)) {
    if (!seen.has(key)) next.push(`${key}=${formatEnvValue(value)}`);
  }

  // 權限設成只有擁有者能讀寫，避免同機其他使用者讀到金鑰
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next.join('\n') + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows／WSL 的某些檔案系統不支援，忽略
  }

  // 立刻套用到目前的 process，不用重啟伺服器
  for (const [key, value] of Object.entries(clean)) {
    if (value) process.env[key] = value;
    else delete process.env[key];
  }

  return Object.keys(clean);
}

/**
 * 寫進 .env 檔的形狀。
 *
 * 為什麼不是直接接上去：dotenv 會把未加引號值後面的 ` #` 當成註解砍掉，
 * 而 model 的 id 與端點雖然通常很乾淨，貼進來的東西不保證。
 * 單引號在 dotenv 裡是「原樣」，所以只要值裡沒有單引號就一律安全。
 */
function formatEnvValue(value) {
  if (value === '') return '';
  if (/^[A-Za-z0-9_\-.:/@+=~]+$/.test(value)) return value;
  // 單引號在 valueProblem() 就擋掉了，這裡只是不要讓將來多一個呼叫端時默默寫壞
  if (value.includes("'")) {
    throw new SettingsError(400, '設定值不能包含單引號（\'）。請確認貼上的內容正確。');
  }
  return `'${value}'`;
}
