import { h, append } from '../lib/dom.js';
import { grid } from '../lib/layout.js';
import { loadVoices, speak } from '../lib/tts.js';
import {
  getSettings, updateSettings, resetSettings, setGoal, DEFAULTS,
  aiMode, setAiMode, AI_FEATURES, AI_MODES,
} from '../lib/settings.js';
import { getUser, logout } from '../lib/session.js';
import {
  ConflictError, applyRemote, describe, describeLocal, fetchRemote, isAutoSyncOn,
  pushOverwrite, setAutoSync, syncNow,
} from '../lib/sync.js';
import {
  resetSrs, clearHistory, getHistory, getSrsState, exportState, importState,
  clearActivity, getActivity, activityDays, getReviews, clearReviews,
} from '../lib/storage.js';
import {
  buildBackup, parseBackup, backupSummary, summaryText, backupFilename,
} from '../lib/backup.js';
import { CATEGORY_LABEL, DIFFICULTY_LABEL, DIFFICULTY_ORDER, formatTime } from '../lib/labels.js';
import { QUIZ_TYPES } from '../lib/quiz.js';
import { PRACTICE_MODES } from '../lib/modes.js';
import { forgetAiReviewAvailability } from '../lib/ai-review.js';
import {
  toggleChip, chipField, multiChipField, textField, numberField, selectField,
} from '../lib/fields.js';

export const meta = { id: 'settings', label: '設定', icon: '⚙️' };

// 情境與難度的清單從 lib/labels.js 長出來，不在這裡再寫死一份 ——
// 句庫已經有八種情境（原本這裡只列四種，新增的四種就選不到）。
const CATEGORIES = Object.entries(CATEGORY_LABEL);

/** 每日目標的快速選項，依模式各給一組合理的量。數字輸入框還在，這幾顆只是省得手打。 */
const GOAL_CHOICES = {
  vocabulary: [10, 20, 30, 50],
  listening: [1, 2, 4, 8],   // 單位是「組」不是「題」——一組要聽完再答 2～6 題
  translation: [5, 10, 20, 30],
  dialogue: [3, 6, 10, 20],
  shadowing: [3, 5, 10, 20],
};
const DIFFICULTIES = DIFFICULTY_ORDER.map((id) => [id, DIFFICULTY_LABEL[id]]);

let voices = [];
let models = [];
let caps = null;   // /api/capabilities：伺服器現在有沒有金鑰、講評走哪條路
let serverSettings = null;
let serverError = '';
// 金鑰只有擁有者（第一個註冊的帳號）改得動 —— 伺服器端會擋（見 server/settings.js），
// 這兩個旗標只是為了不要讓別人看到一張按下去就 403 的表單。
let isOwner = false;
let knowWhoIAm = false;
// 每一區自己的「儲存中…／已儲存／⚠️」訊息。共用一個的話，存了 Azure 金鑰
// 之後那句「已儲存」會出現在 Gemini 那一區底下
let saveStates = {};
// 哪幾區的摺疊是打開的。**mount 時算一次**（沒設定的展開），之後跟著使用者
// 自己的開關走 —— 每次 render 重算的話，存完一次就會被收起來
let openSections = {};
let quotaSaveState = '';
let backupState = '';
let syncState = '';
let root = null;

export async function mount(container) {
  root = container;
  voices = (await loadVoices()).filter((v) => v.lang?.startsWith('en'));

  const user = getUser();
  knowWhoIAm = Boolean(user);
  isOwner = user?.owner === true;
  // 上一次進來的訊息不要留到下一次 —— 「✅ 已儲存」掛在一張還沒動過的表單上
  // 很容易讓人以為剛剛那次操作有存到
  saveStates = {};
  quotaSaveState = '';

  // 不是擁有者就不要打這個端點 —— 伺服器會回 403，而那個 403 會在
  // console 裡變成一條紅字，看起來像壞了。
  if (isOwner) {
    try {
      const res = await fetch('/api/settings');
      const body = await res.json();
      if (!res.ok) serverError = body?.message ?? `HTTP ${res.status}`;
      else serverSettings = body;
    } catch (err) {
      serverError = '讀不到伺服器設定，請確認後端還在執行。';
    }
  }

  // 三組金鑰的摺疊：**沒設定的展開、設定好的收起來**。
  //
  // 只在這裡算一次。每次 render 都重算的話，存完一次金鑰那一區就會自己收起來
  // —— 而使用者接下來多半正要改同一區的另一格（例如剛存完 Azure 金鑰要填區域）。
  openSections = {
    gemini: !serverSettings?.GEMINI_API_KEY?.configured,
    endpoint: !serverSettings?.NARRATION_MODEL?.value,
    azure: !serverSettings?.AZURE_SPEECH_KEY?.configured,
  };

  // model 清單拿不到不是致命錯誤 —— 收起選單，讓後端用它的預設值就好
  try {
    const res = await fetch('/api/models');
    const body = await res.json();
    models = Array.isArray(body.models) ? body.models : [];
  } catch {
    models = [];
  }

  // 伺服器現在有什麼能力（有沒有金鑰、講評走哪一條路）。
  //
  // 為什麼每個帳號都拿得到而不是只有擁有者：有沒有設定 Azure 決定「關掉中文講評」
  // 到底省不省得到時間，而跟讀拿不到分數時，這一行是唯一能判斷
  // 「是伺服器沒設定還是我操作錯了」的地方。
  try {
    caps = await (await fetch('/api/capabilities')).json();
  } catch {
    caps = null;
  }

  render();
  return () => { root = null; };
}

function render() {
  if (!root) return;
  // 這些卡沒有一張比別張重要，所以是多欄的網格而不是主 / 輔 ——
  // 單欄排下來 1440×900 要捲三個螢幕才看得完
  // 排法是「先講這台機器會做什麼，再講它拿什麼做的，最後才是我的資料」：
  //   AI 三張排在一起（功能 → 金鑰與模型 → 上限）—— 它們原本散在三個地方，
  //   而使用者要調整的時候，這幾件事幾乎一定是一起看的
  //   接著是練習本身（目標、偏好、語音），最後是帳號與資料
  append(grid(root),
    aiCard(), modelCard(), quotaCard(),
    goalCard(), practiceCard(), voiceCard(), syncCard(), dataCard());
}

// ─── AI 功能：三個會呼叫模型的東西，用同一組選項 ─────────────────────────
//
// 為什麼要有這張卡：這三個開關原本散在三個地方（跟讀的講評在「練習偏好」裡、
// 情境對話的修正在它旁邊、而「現在走哪個模型」在另一張卡），
// 但使用者心裡它們是同一件事：**這個 App 什麼時候會去花錢、花多久**。
//
// 三個都是自動／手動／關，而不是開／關：這些是唯一會花錢也唯一要等的功能，
// 「今天先不自動，但這一句我真的想知道」是最常見的狀態，而開／關表達不出來。
function aiCard() {
  const card = h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '🤖 AI 功能'),
    h('p', { class: 'hint' },
      '三個會呼叫模型的功能。自動＝每次都要（要等幾秒、每次都算一次額度）；' +
      '手動＝畫面上留一個按鈕，按了才呼叫；關＝完全不呼叫（改用本地的批改與摘要）。'),
  );

  for (const feature of AI_FEATURES) {
    const current = aiMode(feature.id);
    append(card, chipField(
      feature.label,
      AI_MODES,
      current,
      (mode) => { setAiMode(feature.id, mode); render(); },
      { hint: feature[current] ?? '' },
    ));
  }

  append(card,
    aiStatusLine(),
    // 這裡只放一行「今天用了幾次」。細節（分模型、怎麼調）在下面那張卡 ——
    // 同一頁上把同一組數字寫兩次，第二次就變成雜訊
    usageLine({ compact: true }),
    h('p', { class: 'hint' },
      '已經拿到的修正會存下來，同一句話再問一次不會重複呼叫（設定 → 學習資料看得到有幾筆）。'),
  );
  return card;
}

/**
 * 「現在真的接得到哪個模型」。**讀的是伺服器狀態**，不是這台裝置的設定。
 *
 * 為什麼一定要有：上面三個開關只決定「什麼時候要」，能不能要是伺服器決定的。
 * 少了這一行，設好了卻沒生效時，畫面上完全看不出原因。
 */
function aiStatusLine() {
  const ai = caps?.aiReview ?? null;
  if (!ai) return h('p', { class: 'hint' }, '（讀不到伺服器狀態，無法確認現在接得到哪個模型。）');

  const where = isOwner ? '下面的「AI 金鑰與模型」' : '伺服器的設定（要擁有者的帳號才改得動）';
  if (!ai.ready) {
    return h('p', { class: 'hint hint--warn' },
      `⚠️ 現在沒有可以呼叫的模型（${ai.problem}）—— 上面選「自動」也不會有東西出現。` +
      `請到${where}補上。`);
  }
  return h('p', { class: 'hint' },
    `目前由 ${ai.label}${ai.model ? ` 的 ${ai.model}` : ''} 產生（要換請看${where}）。`);
}

// ─── AI 金鑰與模型：一張卡，重要的在上面，細節收在摺疊裡 ─────────────────
//
// 為什麼合成一張：金鑰與 model 原本是兩張卡，但它們回答的是**同一個問題** ——
// 「這台伺服器拿什麼在做 AI」。分兩張的代價是：換一個模型要在兩張卡之間來回
// （來源在這張、Gemini 的 model 在那張），而「填了金鑰卻沒生效」時也看不出
// 是哪一張的問題。
//
// 卡內的順序是**按「多久會動一次」排的**：
//   1. 來源與 model —— 換模型是會反覆調的事（想快一點、想省一點）
//   2. 現在真的接得到什麼 —— 改完馬上要確認的那一行
//   3. 三組金鑰，各自收在摺疊裡 —— 填一次就不再看，攤開來只是擋住上面兩件事
//
// 摺疊的預設狀態是「**沒設定的展開、設定好的收起來**」：全新安裝時三組都攤開
// （有事要做），設好之後自動變乾淨。使用者手動開關過的狀態會記住到離開設定頁，
// 不然存完一次金鑰就被收起來，接著想改區域又要再點開。
//
// 這張卡**只有擁有者填得動**（第一個註冊的帳號）。以前這裡擋的是
// 「請求是不是從 localhost 來的」，走 Docker／網域時一律 403 —— 手機上設不了，
// 只能 ssh 進伺服器編輯 .env 再重啟。有帳號之後那一關換成
// 「要登入 + 要是擁有者」，所以現在手機上也設得了。詳見 server/settings.js。
function modelCard() {
  const card = h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '🧠 AI 金鑰與模型'),
    h('p', { class: 'hint' },
      '上面三個 AI 功能都走這裡設的模型。金鑰是選用的 —— 不填也能正常使用單字卡、' +
      '聽力、中翻英與情境對話（少的是 AI 那幾段），跟讀也還是可以錄音比對。'),
  );

  // 別人的帳號：不給看也不給改，但要看得到「現在到底有沒有設定」——
  // 不然跟讀拿不到分數時，他無從判斷是伺服器沒設定還是自己操作錯了
  if (knowWhoIAm && !isOwner) {
    append(card,
      h('p', { class: 'hint' },
        '金鑰與模型由擁有者（這台伺服器上第一個註冊的帳號）設定 —— 這個帳號看不到也改不了。'),
      serverStatusLine(),
    );
    return card;
  }

  if (!knowWhoIAm) {
    append(card, h('p', { class: 'hint' },
      '現在讀不到登入狀態（可能是離線），所以看不到金鑰設定。連上線之後重新整理就會出現。'));
    return card;
  }
  if (serverError) {
    append(card, h('div', { class: 'banner banner--error' }, serverError));
    return card;
  }
  if (!serverSettings) {
    append(card, h('p', { class: 'hint' }, '載入中…'));
    return card;
  }

  const provider = serverSettings.NARRATION_PROVIDER.value;

  append(card,
    // ── 1. 最上面：走哪一條路 ──────────────────────────────────────────
    //
    // 用 chip 而不是下拉：只有四個值，而下拉要多按一下才看得到自己有哪些選擇
    // （跟設定頁其他地方同一條規則，見 lib/fields.js）。
    // 按下去**直接存**，因為它是單一個值、沒有東西要一起填
    chipField('來源', [
      ['', '自動'],
      ['gemini', 'Gemini'],
      ['openai', 'OpenAI 相容端點'],
      ['local', '不呼叫模型'],
    ], provider, saveProvider, {
      hint: PROVIDER_HINT[provider] ?? PROVIDER_HINT[''],
      extra: saveStates.provider
        ? h('p', { class: `hint ${saveTone(saveStates.provider)}` }, saveStates.provider)
        : null,
    }),

    // 走 Gemini 時用哪個 model。這是**這台裝置的偏好**（存在 localStorage），
    // 但它跟上面那一排回答的是同一個問題「要用哪個模型」——
    // 放在別張卡上，換模型的人一定會漏掉其中一個。
    //
    // 來源不是 Gemini 時**照樣顯示**，只是說清楚它現在沒有作用：
    // 控制項在切換來源時消失不見，會讓人以為設定被吃掉了
    models.length > 0 && selectField(
      '走 Gemini 時用哪個 model',
      'gemini-model',
      models.map((m) => [m.id, m.label ?? m.id]),
      getSettings().geminiModel,
      (value) => { updateSettings({ geminiModel: value }); render(); },
      {
        note: (models.find((m) => m.id === getSettings().geminiModel)?.note ?? '') +
          '　這是這台裝置的選擇（清單寫死在後端，送上來的值也會再驗一次）。' +
          (provider === 'openai' || provider === 'local'
            ? `　目前的來源不是 Gemini，所以這一格${provider === 'local' ? '沒有作用' : '要等來源切回 Gemini 才有作用'}。`
            : ''),
      },
    ),

    // ── 2. 改完馬上要確認的那一行 ──────────────────────────────────────
    serverStatusLine(),

    // ── 3. 金鑰：填一次就不再看的東西，收起來 ──────────────────────────
    keySection('gemini', 'Gemini 金鑰', geminiSection()),
    keySection('endpoint', 'OpenAI 相容端點（Hugging Face／Groq／Ollama）', endpointSection()),
    keySection('azure', 'Azure Speech（跟讀的發音評分）', azureSection()),

    h('p', { class: 'hint' },
      '金鑰存了立刻生效，不用重啟。它們寫在伺服器的資料目錄裡' +
      '（DATA_DIR/settings.env，權限 600），不會存在瀏覽器裡，也不會完整回傳到前端' +
      '—— 上面只看得到末四碼。留空表示不變更；要清除請輸入一個空格再儲存。'),
  );
  return card;
}

/** 每一種來源選了會怎樣。**每個值各一句** —— 那正是按下去之前想知道的事。 */
const PROVIDER_HINT = {
  '': '有 Gemini 金鑰就用 Gemini，否則看下面的端點設定齊了沒。',
  gemini: '用 Gemini（要有 Gemini 金鑰）。品質穩，但講評那一段實測幾秒到十幾秒。',
  openai: '用下面設定的端點。這是「想更快」的那條路 —— HF 的 Inference Providers、' +
    'Groq、或自己機器上的 Ollama，實測一兩秒。',
  local: '完全不呼叫模型：跟讀退回本地摘要，而 AI 修正沒有替代品可以退 —— 那兩個模式的修正會停在「不能用」。',
};

/**
 * 一組收起來的金鑰設定。
 *
 * 開關狀態記在 `openSections` 而不是每次 render 重算，理由見 `modelCard()` ——
 * 存完一次就被收起來的話，接著想改同一區的另一格又要再點一次。
 */
function keySection(id, title, body) {
  return h('details', {
    class: 'field keys',
    open: openSections[id] === true,
    ontoggle: (e) => { openSections[id] = e.currentTarget.open; },
  },
    h('summary', { class: 'keys__summary' }, title),
    body,
  );
}

function geminiSection() {
  const gemini = serverSettings.GEMINI_API_KEY;
  return h('div', {},
    textField('Gemini API 金鑰', 'gemini-key', {
      type: 'password',
      placeholder: gemini.configured ? `目前已設定（${gemini.preview}）` : '尚未設定',
      note: '到 https://aistudio.google.com/apikey 產生一組。' +
        '沒有 Azure 金鑰時，跟讀的分數也會由 Gemini 給（主觀分數）。',
    }),
    saveRow('gemini', '儲存 Gemini 金鑰', saveGemini),
  );
}

function endpointSection() {
  const key = serverSettings.NARRATION_API_KEY;
  return h('div', {},
    textField('端點 base URL', 'narration-base-url', {
      type: 'text',
      value: serverSettings.NARRATION_BASE_URL.value,
      placeholder: 'https://router.huggingface.co/v1',
      note: '填到 /v1 就好，/chat/completions 那一段伺服器會自己接。' +
        'Hugging Face 要用 router.huggingface.co（api-inference 那個舊端點有冷啟動，會更慢）。',
    }),
    textField('端點金鑰', 'narration-key', {
      type: 'password',
      placeholder: key.configured ? `目前已設定（${key.preview}）` : '尚未設定',
      note: '供應商給的 token。Ollama 這種本機端點隨便填一個非空字串就行。',
    }),
    textField('model', 'narration-model', {
      type: 'text',
      value: serverSettings.NARRATION_MODEL.value,
      placeholder: '照供應商列的 id 完整填',
      note: 'HF 的 router 可以在後面加「:供應商」指定要轉給誰（例如 :groq）。',
    }),
    saveRow('endpoint', '儲存端點設定', saveEndpoint),
    h('p', { class: 'hint' },
      '三格要一起齊才會生效。這條路失敗不會自動改打 Gemini —— 會退回本地摘要，' +
      '而上面那行「目前」就會寫出缺什麼或哪裡不通。'),
  );
}

function azureSection() {
  const azureKey = serverSettings.AZURE_SPEECH_KEY;
  return h('div', {},
    h('p', { class: 'hint' },
      'Azure 只給跟讀的發音評分（逐字、逐音素的客觀分數），跟上面三個 AI 功能無關。'),
    textField('Azure Speech 金鑰', 'azure-key', {
      type: 'password',
      placeholder: azureKey.configured ? `目前已設定（${azureKey.preview}）` : '尚未設定',
      note: '到 Azure 入口網站建立「語音服務」資源，在「金鑰與端點」複製 KEY 1。',
    }),
    textField('Azure 區域', 'azure-region', {
      type: 'text',
      value: serverSettings.AZURE_SPEECH_REGION.value,
      placeholder: '例如 eastasia',
      note: '必須跟建立資源時選的區域一致，填錯會認證失敗。',
    }),
    saveRow('azure', '儲存 Azure 金鑰', saveAzure),
  );
}

/** 儲存按鈕 + 那一區自己的訊息。三區各一組 —— 共用一個的話，訊息會出現在錯的地方。 */
function saveRow(id, label, onclick) {
  return h('div', { class: 'row' },
    h('button', { class: 'btn btn--primary', onclick }, label),
    saveStates[id] && h('span', { class: `hint ${saveTone(saveStates[id])}` }, saveStates[id]),
  );
}

/**
 * 現在伺服器實際上有沒有評分能力（讀的是 /api/capabilities，不是這台裝置的設定）。
 *
 * 為什麼一定要有這一行：填完金鑰之後「到底生效了沒」是唯一真正想知道的事，
 * 而「已儲存」只證明檔案寫好了。存完之後 postSettings() 會就地更新它。
 */
function serverStatusLine() {
  if (!caps) {
    return h('p', { class: 'hint' }, '（讀不到伺服器狀態。）');
  }
  const narration = caps.narration;
  const parts = [
    `發音評分：${caps.azureConfigured ? 'Azure（客觀分數）' : 'Gemini（主觀分數）'}`,
    `講評：${narration
      ? (narration.ready ? `${narration.label}${narration.model ? `（${narration.model}）` : ''}`
        : `本地摘要（${narration.label} ${narration.problem}）`)
      : '未知'}`,
  ];
  const bad = !caps.azureConfigured && !caps.geminiConfigured;
  return h('p', { class: `hint ${bad ? 'hint--warn' : ''}` },
    (bad ? '⚠️ 兩組金鑰都沒設定，送出錄音一定會失敗。目前 —— ' : '目前 ') + parts.join('，'));
}

// ─── 每天的呼叫上限 ──────────────────────────────────────────────────────
//
// 這張卡**每個帳號都看得到**，但只有擁有者改得動。
//
// 為什麼別人也要看得到：額度是**共用的一個預算**（所有模式一起算），
// 而「今天的 AI 修正怎麼不見了」在看不到數字的情況下完全無法自己判斷 ——
// 那是額度用完了、金鑰壞了、還是網路不通，三件事的畫面幾乎一樣。
function quotaCard() {
  const card = h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '每天的呼叫上限'),
    h('p', { class: 'hint' },
      '所有模式加在一起算 —— 跟讀的發音評分與中文講評、情境對話的 AI 修正，' +
      '全部記在同一個計數裡。這是唯一擋得住「按錯一直重試把配額燒光」的東西。'),
    usageLine(),
  );

  if (!isOwner) {
    append(card, h('p', { class: 'hint' },
      '上限由擁有者（第一個註冊的帳號）設定 —— 這個帳號改不了，但上面的數字是你自己今天用掉的。'));
    return card;
  }
  if (serverError || !serverSettings) return card;

  append(card,
    textField('每天最多幾次（全部模式）', 'quota-total', {
      type: 'text',
      value: serverSettings.AI_DAILY_LIMIT?.value ?? '',
      placeholder: '留空 = 預設 200；填 off = 不限制',
      note: '扣的時機是「呼叫之前」—— 所以就算模型沒回來，那一次也算用掉了（錢真的花了）。',
    }),
    textField('個別模型的上限（選填）', 'quota-per-model', {
      type: 'text',
      value: serverSettings.AI_DAILY_LIMITS?.value ?? '',
      placeholder: 'gemini=50; openai/gpt-oss-120b:groq=500; azure=off',
      note: '寫成「model=次數」，多個用分號隔開。' +
        '只寫供應商名稱（gemini / openai / azure）的話，那條路的所有 model 都算同一個上限。' +
        '總量與這裡的上限「兩道都要過」，任一個滿了就擋。',
    }),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn--primary', onclick: saveQuota }, '儲存上限'),
      quotaSaveState &&
        h('span', { class: `hint ${saveTone(quotaSaveState)}` }, quotaSaveState),
    ),
  );
  return card;
}

/** 今天用了幾次 / 上限。`caps.usage` 是這個帳號的，`caps.quota` 是伺服器的設定。 */
function usageLine({ compact = false } = {}) {
  const usage = caps?.usage;
  const limit = caps?.quota?.total ?? null;
  if (!usage) {
    return h('p', { class: 'hint' }, '（讀不到今天的用量，連上線之後重新整理就會出現。）');
  }

  const headline = `今天已經用了 ${usage.total} 次` +
    (limit === null ? '（沒有上限）' : ` / 上限 ${limit} 次`);
  if (compact) {
    return h('p', { class: 'hint' }, `${headline}（所有模式一起算，細節見下面「每天的呼叫上限」）。`);
  }

  const byKey = Object.entries(usage.byKey ?? {})
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key} ${n}`)
    .join('・');

  return h('div', {},
    h('p', { class: 'field__label' }, headline),
    byKey && h('p', { class: 'hint' }, `分別是：${byKey}`),
    h('p', { class: 'hint' }, '每天從 0 開始（伺服器的日期），數字存在伺服器上 —— ' +
      '換裝置或清除瀏覽器資料都不會重新計算。'),
  );
}

async function saveQuota() {
  const get = (id) => root?.querySelector(`#${id}`)?.value ?? '';
  const payload = {};

  for (const [id, envKey] of [
    ['quota-total', 'AI_DAILY_LIMIT'],
    ['quota-per-model', 'AI_DAILY_LIMITS'],
  ]) {
    const value = get(id).trim();
    if (value !== (serverSettings?.[envKey]?.value ?? '')) payload[envKey] = value;
  }

  if (Object.keys(payload).length === 0) {
    quotaSaveState = '沒有變更';
    return render();
  }

  quotaSaveState = '儲存中…';
  render();
  quotaSaveState = await postSettings(payload);
  render();
}

function saveTone(state) {
  if (state.startsWith('✅')) return 'hint--ok';
  if (state.startsWith('⚠️')) return 'hint--error';
  return '';   // 「儲存中…」「沒有變更」是中性訊息，不要標成錯誤
}

/**
 * 三個儲存動作，一區一個。
 *
 * 為什麼不是一顆「全部儲存」：三區各自獨立（Azure 跟講評模型完全無關），
 * 而合成一顆的話「已儲存」出現時，使用者不知道剛剛到底送出了哪幾個欄位 ——
 * 尤其金鑰欄是密碼欄，畫面上看不出它有沒有被動到。
 *
 * 每一區的規則都一樣：**金鑰欄空字串 = 不變更**（要清除得輸入一個空格），
 * 看得到目前值的欄位則是「跟目前不一樣才送」—— 那樣清空一格才有辦法表達
 * 「把它清掉」。
 */
async function saveAzure() {
  const get = (id) => root?.querySelector(`#${id}`)?.value ?? '';
  const payload = {};

  const key = get('azure-key');
  if (key !== '') payload.AZURE_SPEECH_KEY = key.trim();
  const region = get('azure-region');
  if (region !== (serverSettings?.AZURE_SPEECH_REGION.value ?? '')) {
    payload.AZURE_SPEECH_REGION = region.trim();
  }
  return saveSection('azure', payload);
}

async function saveGemini() {
  const key = root?.querySelector('#gemini-key')?.value ?? '';
  return saveSection('gemini', key === '' ? {} : { GEMINI_API_KEY: key.trim() });
}

async function saveEndpoint() {
  const get = (id) => root?.querySelector(`#${id}`)?.value ?? '';
  const payload = {};

  const key = get('narration-key');
  if (key !== '') payload.NARRATION_API_KEY = key.trim();

  for (const [id, envKey] of [
    ['narration-base-url', 'NARRATION_BASE_URL'],
    ['narration-model', 'NARRATION_MODEL'],
  ]) {
    const value = get(id).trim();
    if (value !== (serverSettings?.[envKey].value ?? '')) payload[envKey] = value;
  }
  return saveSection('endpoint', payload);
}

/**
 * 「來源」那一排 chip 按下去就直接存。
 *
 * 它跟金鑰不一樣：只有一個值、沒有東西要一起填，所以沒有理由再按一次儲存
 * （設定頁其他的 chip 也都是按了就生效，見 lib/fields.js）。
 */
async function saveProvider(value) {
  if (value === (serverSettings?.NARRATION_PROVIDER.value ?? '')) return;
  return saveSection('provider', { NARRATION_PROVIDER: value });
}

async function saveSection(id, payload) {
  if (Object.keys(payload).length === 0) {
    saveStates[id] = '沒有變更';
    return render();
  }
  saveStates[id] = '儲存中…';
  render();
  saveStates[id] = await postSettings(payload);
  render();
}

/** POST /api/settings，回一句要顯示的話。成功時順手更新畫面上的「目前」那一行。 */
async function postSettings(payload) {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) return `⚠️ ${body?.message ?? `HTTP ${res.status}`}`;

    serverSettings = body.settings;
    // 後端連同「現在有什麼能力」一起回來（跟 /api/capabilities 同一份）——
    // 存完之後「目前」那一行要馬上對，不然使用者會以為沒生效而重複儲存。
    // 前端自己推的話就會有第二份規則（Azure 要 key 和 region 都有才算）
    // usage（這個帳號今天用了幾次）不在 capabilities() 裡 —— 那一份是整台機器共用的。
    // 不留著的話，存完上限之後上面那行用量會變成「讀不到」
    if (body.capabilities) caps = { ...body.capabilities, usage: caps?.usage };
    // 情境對話那邊自己快取了一份「AI 修正能不能用」（同一次載入只問一趟）。
    // 不丟掉的話，剛剛才設好金鑰卻要重新整理才會通 —— 而那看起來就是沒生效
    forgetAiReviewAvailability();
    return '✅ 已儲存，立即生效（不用重啟）';
  } catch (err) {
    return '⚠️ 連不上伺服器';
  }
}

// ─── 每日目標 ────────────────────────────────────────────────────────────
//
// 五個模式各一個數字，放在同一張卡上 —— 分散在各模式裡的話，
// 「我每天總共要練多少」這個問題就得切五個分頁才回答得出來。
function goalCard() {
  const s = getSettings();

  return h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '每日目標'),
    h('p', { class: 'hint' },
      '每個模式每天練幾個。練滿了會告訴你今天完成了，但不會擋著不讓你繼續練 ——' +
      '目標是拿來知道自己完成了，不是拿來鎖門的。0 表示不設目標。'),

    // 每個模式一組快速選項 + 一個數字框。**快速選項用的是跟別處一樣的 chip**
    // （按下去就生效），數字框給的是「我就是要 37」那種情況
    PRACTICE_MODES.map((mode) => h('div', { class: 'field' },
      h('span', { class: 'field__label' }, `${mode.icon} ${mode.label}`),
      h('div', { class: 'chips' },
        GOAL_CHOICES[mode.id].map((n) => toggleChip(
          `${n} ${mode.unit}`,
          (s.dailyGoals?.[mode.id] ?? 0) === n,
          () => { setGoal(mode.id, n); render(); },
        ))),
      h('input', {
        class: 'field__input', id: `goal-${mode.id}`, type: 'number', min: '0', max: '500',
        'aria-label': `${mode.label}每天練幾${mode.unit}`,
        value: String(s.dailyGoals?.[mode.id] ?? 0),
        onchange: (e) => { setGoal(mode.id, e.target.value); render(); },
      }),
    )),

    h('p', { class: 'hint' },
      '單字卡的目標同時決定一輪抽幾張（到期要複習的優先，再補沒學過的）；' +
      '其他模式只是拿來記錄與累積連續天數，不會限制你能練多少。'),
  );
}

// ─── 練習偏好 ────────────────────────────────────────────────────────────
//
// 這張卡只放**跟內容有關**的選擇（練什麼、怎麼出題），不放 AI ——
// AI 那三個開關在最上面那張卡，理由見那裡。
function practiceCard() {
  const s = getSettings();

  return h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '練習偏好'),

    multiChipField('只練這些情境', CATEGORIES, s.categories,
      (next) => { updateSettings({ categories: next }); render(); },
      { hint: s.categories.length === 0 ? '目前：全部情境' : `目前：${s.categories.length} 個情境` }),

    multiChipField('只練這些難度', DIFFICULTIES, s.difficulties,
      (next) => { updateSettings({ difficulties: next }); render(); },
      { hint: s.difficulties.length === 0 ? '目前：全部難度' : `目前：${s.difficulties.length} 種難度` }),

    multiChipField('單字卡的題型', QUIZ_TYPES.map((t) => [t.id, t.label]), s.vocabQuizTypes,
      (next) => { updateSettings({ vocabQuizTypes: next }); render(); },
      {
        hint: s.vocabQuizTypes.length === 0
          ? '一種都沒選 —— 會用翻卡（自己判斷記不記得）。'
          : '勾幾種就混哪幾種出題。選擇題是四選一，干擾項只會從同一級裡挑' +
            '跟答案完全不同義的字，所以不會出現兩個都對的選項。',
      }),

    chipField('中翻英題型',
      [['all', '兩種都要'], ['cloze', '只練填空'], ['sentence', '只練整句']],
      s.translationType,
      (value) => { updateSettings({ translationType: value }); render(); }),

    chipField('聽力的錄音',
      [[false, '按了才播'], [true, '換一題就自動播']],
      s.autoPlayListening === true,
      (value) => { updateSettings({ autoPlayListening: value }); render(); },
      {
        hint: s.autoPlayListening
          ? '換到新的一組就自動唸一次（還是可以按 P 重聽）。'
          : '自己按播放。想連著練的時候可以改成自動。',
      }),

    chipField('跟讀抽句',
      [[true, '優先練弱點'], [false, '完全隨機']],
      s.shadowingWeighted !== false,
      (value) => { updateSettings({ shadowingWeighted: value }); render(); },
      {
        hint: s.shadowingWeighted !== false
          ? '分數低的、久沒練的、以及練得到你常錯的音的句子會比較常出現。'
          : '每一句機率一樣。覺得「怎麼一直抽到同幾句」的時候用這個。',
      }),
  );
}

// ─── 語音 ────────────────────────────────────────────────────────────────
function voiceCard() {
  const s = getSettings();

  if (voices.length === 0) {
    return h('div', { class: 'card' },
      h('p', { class: 'card__title' }, '語音'),
      h('p', { class: 'hint' },
        '找不到英語語音。請到作業系統的語音設定安裝英語語音包，或改用 Chrome / Edge。'),
    );
  }

  return h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '語音'),
    // 語音清單可能有幾十個，是這個 App 裡唯一真的需要 select 的地方
    // （其餘幾個選項都是三四個值，用 chip 才看得到自己有哪些選擇）
    selectField(
      `示範發音的聲音（找到 ${voices.length} 個英語語音）`,
      'voice',
      [['', '自動挑選（優先 en-US）'], ...voices.map((v) => [v.name, `${v.name}（${v.lang}）`])],
      s.ttsVoice,
      (value) => { updateSettings({ ttsVoice: value }); render(); },
    ),
    h('div', { class: 'field' },
      h('label', { class: 'field__label', for: 'rate' }, `語速：${s.ttsRate.toFixed(2)}×`),
      h('input', {
        class: 'field__range', id: 'rate', type: 'range',
        min: '0.5', max: '1.3', step: '0.05', value: String(s.ttsRate),
        oninput: (e) => { updateSettings({ ttsRate: Number(e.target.value) }); render(); },
      }),
      h('p', { class: 'hint' }, '慢一點比較聽得清楚細節，快一點比較接近真實語速。'),
    ),
    h('button', {
      class: 'btn btn--ghost',
      onclick: (e) => {
        // 事件派送結束後 e.currentTarget 會變成 null，
        // 所以要在同步階段先把元素抓下來再進非同步流程
        const btn = e.currentTarget;
        btn.disabled = true;
        speak('This is how the example sentences will sound.')
          .catch((err) => console.error('[tts]', err))
          .finally(() => { btn.disabled = false; });
      },
    }, '🔊 試聽'),
  );
}

// ─── 跨裝置同步 ──────────────────────────────────────────────────────────
//
// **階段 A 是手動的整包上傳／下載**，不是自動合併（設計與階段 B 寫在
// `docs/accounts-and-sync.md`）。所以這裡的語意跟匯出／匯入一樣是「覆蓋」，
// 而每一個覆蓋動作都先講清楚用什麼覆蓋什麼 —— 只問「確定嗎」等於沒問。
function syncCard() {
  const user = getUser();

  return h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '跨裝置同步'),
    user
      ? h('p', { class: 'who' }, `目前登入：${user.username}`)
      : h('p', { class: 'hint hint--warn' },
        '沒有登入，所以同步不了 —— 進度只留在這個瀏覽器裡。'),

    h('p', { class: 'hint' },
      '進度存在你自己的伺服器上，而且是',
      h('strong', {}, '自動'),
      '合併的：打開 App 時、切到背景時、以及練完一段之後都會同步一次。' +
      '兩台裝置各練各的，數字會加起來。'),

    user && h('div', { class: 'field' },
      h('span', { class: 'field__label' }, '自動同步'),
      h('div', { class: 'chips' },
        [[true, '開'], [false, '關（只手動）']].map(([value, label]) =>
          toggleChip(label, isAutoSyncOn() === value, () => {
            setAutoSync(value);
            // 這是**這台裝置**的選擇，不會跟著同步到別台 ——
            // 所以它不放在 settings 裡（那個會同步）
            syncState = value
              ? '已開啟自動同步。重新整理之後生效。'
              : '已關閉自動同步 —— 這台裝置只會在你按「現在同步」時同步。';
            render();
          }))),
    ),

    user && h('div', { class: 'row' },
      h('button', { class: 'btn btn--primary', onclick: syncNowClicked }, '🔄 現在同步'),
      h('button', { class: 'btn btn--ghost', onclick: signOut }, '登出'),
    ),

    syncState && h('p', { class: 'hint' }, syncState),

    // 覆蓋是**逃生門**，不是日常操作 —— 所以收在 details 裡，
    // 而且每一次都會先把兩邊的內容並排出來讓人確認
    user && h('details', { class: 'field' },
      h('summary', {}, '整包覆蓋（自動合併出問題時才用）'),
      h('p', { class: 'hint' },
        '這兩顆是',
        h('strong', {}, '覆蓋'),
        '不是合併：會讓其中一邊的進度完全取代另一邊。' +
        '自動合併壞掉、或想強制讓某一台的版本說話時才用。'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: uploadProgress }, '⬆️ 用這台覆蓋伺服器'),
        h('button', { class: 'btn', onclick: downloadProgress }, '⬇️ 用伺服器覆蓋這台'),
      ),
    ),
  );
}

async function syncNowClicked() {
  syncState = '同步中…';
  render();
  const { merged, error } = await syncNow();
  if (error) {
    syncState = `這次沒同步成功：${error.message}`;
    return render();
  }
  if (merged) {
    // 合併之後本機的資料變了 —— 重載是唯一能保證每個模組都看到新資料的做法
    window.location.reload();
    return;
  }
  syncState = `已同步，兩邊一樣（${describeLocal()}）。`;
  render();
}

async function uploadProgress() {
  syncState = '上傳中…';
  render();
  try {
    const res = await pushOverwrite();
    syncState = `已上傳（${describeLocal()}），伺服器版本 ${res.rev}。`;
  } catch (err) {
    if (err instanceof ConflictError) {
      // 伺服器上有這台裝置沒看過的東西 —— 覆蓋前一定要把兩邊都列出來
      const ok = window.confirm(
        '伺服器上的進度比這台裝置知道的新（可能是另一台裝置上傳過）。\n\n' +
        `伺服器上：${describe(err.current?.data)}\n` +
        `這台裝置：${describeLocal()}\n\n` +
        '要用這台裝置的進度覆蓋伺服器上的嗎？覆蓋之後無法復原。'
      );
      if (!ok) {
        syncState = '已取消上傳。要改成拿伺服器的版本請按「從伺服器下載」。';
        return render();
      }
      try {
        const res = await pushOverwrite({ force: true });
        syncState = `已覆蓋伺服器上的進度，版本 ${res.rev}。`;
      } catch (err2) {
        syncState = `上傳失敗：${err2.message}`;
      }
    } else {
      syncState = `上傳失敗：${err.message}`;
    }
  }
  render();
}

async function downloadProgress() {
  syncState = '讀取中…';
  render();
  try {
    const remote = await fetchRemote();
    if (!remote.rev) {
      syncState = '伺服器上還沒有任何進度 —— 請先在某一台裝置按「上傳」。';
      return render();
    }

    if (!window.confirm(
      '要用伺服器上的進度覆蓋這台裝置嗎？\n\n' +
      `伺服器上：${describe(remote.data)}\n` +
      `這台裝置：${describeLocal()}\n\n` +
      '這台裝置現在的進度會被取代，而且無法復原。'
    )) {
      syncState = '已取消下載。';
      return render();
    }

    applyRemote(remote);
    // 重新整理而不是重畫：設定與複習進度都有模組層級的快取，
    // 重載是唯一能保證每個模組都看到新資料的做法（還原備份也是同一個理由）
    window.location.reload();
  } catch (err) {
    syncState = `下載失敗：${err.message}`;
    render();
  }
}

async function signOut() {
  if (!window.confirm(
    '登出之後要重新輸入帳號密碼才能繼續練。\n\n' +
    '這台裝置上的學習進度不會被清掉，但還沒上傳的部分也不會自動保留到伺服器 —— ' +
    '要的話請先按「上傳到伺服器」。'
  )) return;

  try {
    await logout();
  } finally {
    window.location.reload();
  }
}

// ─── 學習資料 ────────────────────────────────────────────────────────────
function dataCard() {
  const srsCount = Object.keys(getSrsState()).length;
  const historyCount = getHistory().length;
  // 有練過的日子（任何一個模式都算）—— 連續天數就是從這裡算的
  const activity = getActivity();
  const activeDays = new Set(
    PRACTICE_MODES.flatMap((m) => [...activityDays(activity, m.id)])
  ).size;

  const reviewCount = Object.keys(getReviews()).length;

  return h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '學習資料'),
    h('p', { class: 'hint' },
      `單字卡進度：${srsCount} 張有紀錄　|　跟讀紀錄：${historyCount} 筆　|　` +
      `每日紀錄：${activeDays} 天　|　AI 修正：${reviewCount} 筆。` +
      '這些都存在這個瀏覽器的 localStorage，換瀏覽器或清除瀏覽資料就會消失。'),

    // 備份放在清除按鈕的**上面**：這一區最危險的三顆按鈕就在下面，
    // 而唯一救得回來的方法是先有備份
    h('div', { class: 'row' },
      h('button', { class: 'btn btn--primary', id: 'backup-download', onclick: downloadBackup },
        '⬇️ 下載備份'),
      h('label', { class: 'btn', for: 'backup-file' }, '⬆️ 還原備份'),
      h('input', {
        id: 'backup-file', type: 'file', accept: 'application/json,.json',
        class: 'visually-hidden', onchange: restoreBackup,
      }),
      backupState && h('span', { class: 'hint' }, backupState),
    ),
    h('p', { class: 'hint' },
      '備份是一個 JSON 檔，包含複習進度、每日紀錄、跟讀紀錄、AI 修正紀錄與偏好設定（不含金鑰）。' +
      '換瀏覽器、換電腦、或清除瀏覽資料之前先下載一份 —— 這些東西重建不出來。'),

    h('div', { class: 'row' },
      h('button', {
        class: 'btn btn--danger',
        onclick: () => confirmThen('確定要清除所有單字卡的複習進度嗎？這無法復原。',
          () => { resetSrs(); render(); }),
      }, '清除單字卡進度'),
      h('button', {
        class: 'btn',
        onclick: () => confirmThen('確定要清除跟讀練習紀錄嗎？', () => { clearHistory(); render(); }),
      }, '清除跟讀紀錄'),
      h('button', {
        class: 'btn',
        onclick: () => confirmThen(
          '確定要清除每日紀錄嗎？連續天數會歸零。（複習進度與跟讀成績不受影響）',
          () => { clearActivity(); render(); }),
      }, '清除每日紀錄'),
      // 清掉它的代價要講清楚：這份紀錄同時是「同一句話不要再付一次錢」的快取，
      // 清掉之後練到同一句台詞會重新呼叫一次模型
      reviewCount > 0 && h('button', {
        class: 'btn',
        onclick: () => confirmThen(
          `確定要清除 ${reviewCount} 筆 AI 修正紀錄嗎？\n\n` +
          '它同時是「同一句話不要再呼叫一次」的快取 —— 清掉之後，' +
          '練到同一句台詞會重新花一次額度。',
          () => { clearReviews(); render(); }),
      }, '清除 AI 修正紀錄'),
      h('button', {
        class: 'btn',
        onclick: () => confirmThen('確定要把所有偏好設定恢復成預設值嗎？（不影響金鑰）',
          () => { resetSettings(); render(); }),
      }, '恢復預設設定'),
    ),
  );
}

function confirmThen(message, fn) {
  if (window.confirm(message)) fn();
}

// ─── 備份與還原 ──────────────────────────────────────────────────────────

function downloadBackup() {
  const backup = buildBackup(exportState());
  const blob = new Blob([JSON.stringify(backup, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = h('a', { href: url, download: backupFilename() });
  document.body.append(link);
  link.click();
  link.remove();
  // 不馬上 revoke：Safari 會在點擊真正開始下載之前就把 blob 收掉
  setTimeout(() => URL.revokeObjectURL(url), 10_000);

  backupState = `已下載（${summaryText(backupSummary(backup.data))}）`;
  render();
}

async function restoreBackup(event) {
  // currentTarget 在 await 之後會變成 null，要在同步階段先抓下來
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;

  try {
    const { data, exportedAt } = parseBackup(await file.text());
    const summary = summaryText(backupSummary(data));
    const when = exportedAt ? `（${formatTime(exportedAt) || exportedAt}）` : '';

    // 覆蓋前一定要講清楚「用什麼覆蓋」—— 只問「確定嗎」等於沒問
    if (!window.confirm(
      `要用這份備份${when}覆蓋現在的學習資料嗎？\n\n${summary}\n\n` +
      '現在這台瀏覽器上的進度會被取代，而且無法復原。'
    )) {
      backupState = '已取消還原。';
      return render();
    }

    importState(data);
    // 重新整理而不是重畫：設定、複習進度都有模組層級的快取，
    // 重載是唯一能保證每個模組都看到新資料的做法
    window.location.reload();
  } catch (err) {
    // 用 warn 不用 error：選錯檔案是使用者操作，不是 App 出事。
    // （console.error 留給真正的問題 —— `test/ui.mjs` 最後一條會掃它。）
    console.warn('[backup] 還原被擋下來：', err.message);
    backupState = `還原失敗：${err.message}`;
    render();
  } finally {
    // 清掉選擇，不然選同一個檔案第二次不會觸發 change
    input.value = '';
  }
}
