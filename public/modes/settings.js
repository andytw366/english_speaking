import { h, append } from '../lib/dom.js';
import { grid } from '../lib/layout.js';
import { loadVoices, speak } from '../lib/tts.js';
import { getSettings, updateSettings, resetSettings, setGoal, DEFAULTS } from '../lib/settings.js';
import { getUser, logout } from '../lib/session.js';
import {
  ConflictError, applyRemote, describe, describeLocal, fetchRemote, isAutoSyncOn,
  pushOverwrite, setAutoSync, syncNow,
} from '../lib/sync.js';
import {
  resetSrs, clearHistory, getHistory, getSrsState, exportState, importState,
  clearActivity, getActivity, activityDays,
} from '../lib/storage.js';
import {
  buildBackup, parseBackup, backupSummary, summaryText, backupFilename,
} from '../lib/backup.js';
import { CATEGORY_LABEL, DIFFICULTY_LABEL, DIFFICULTY_ORDER, formatTime } from '../lib/labels.js';
import { QUIZ_TYPES } from '../lib/quiz.js';
import { PRACTICE_MODES } from '../lib/modes.js';

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
let saveState = '';
let narrationSaveState = '';
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
  saveState = '';
  narrationSaveState = '';

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
  append(grid(root),
    apiCard(), isOwner && narrationCard(), goalCard(), practiceCard(),
    voiceCard(), syncCard(), dataCard());
}

// ─── API 金鑰 ────────────────────────────────────────────────────────────
//
// 這張卡**只有擁有者看得到內容**（第一個註冊的帳號）。以前這裡擋的是
// 「請求是不是從 localhost 來的」，走 Docker／網域時一律 403 —— 手機上設不了，
// 只能 ssh 進伺服器編輯 .env 再重啟。有帳號之後那一關換成
// 「要登入 + 要是擁有者」，所以現在手機上也設得了。詳見 server/settings.js。
function apiCard() {
  const card = h('div', { class: 'card' },
    h('p', { class: 'card__title' }, 'API 金鑰（發音評分用）'),
    h('p', { class: 'hint' },
      '這些是選用的 —— 不填也能正常使用單字卡、聽力與中翻英，跟讀也還是可以錄音比對。'),
  );

  // 別人的帳號：不給看也不給改，但要看得到「現在到底有沒有設定」——
  // 不然跟讀拿不到分數時，他無從判斷是伺服器沒設定還是自己操作錯了
  if (knowWhoIAm && !isOwner) {
    append(card,
      h('p', { class: 'hint' },
        '金鑰由擁有者（這台伺服器上第一個註冊的帳號）設定 —— 這個帳號看不到也改不了。'),
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

  const azureKey = serverSettings.AZURE_SPEECH_KEY;
  const gemini = serverSettings.GEMINI_API_KEY;

  append(card,
    field('Azure Speech 金鑰', 'azure-key', {
      type: 'password',
      placeholder: azureKey.configured ? `目前已設定（${azureKey.preview}）` : '尚未設定',
      note: '到 Azure 入口網站建立「語音服務」資源，在「金鑰與端點」複製 KEY 1。',
    }),
    field('Azure 區域', 'azure-region', {
      type: 'text',
      value: serverSettings.AZURE_SPEECH_REGION.value,
      placeholder: '例如 eastasia',
      note: '必須跟建立資源時選的區域一致，填錯會認證失敗。',
    }),
    field('Gemini API 金鑰', 'gemini-key', {
      type: 'password',
      placeholder: gemini.configured ? `目前已設定（${gemini.preview}）` : '尚未設定',
      note: '選用。有的話會把 Azure 的分數寫成中文教練建議；沒有就用本地摘要。',
    }),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn--primary', onclick: saveKeys }, '儲存金鑰'),
      saveState && h('span', { class: `hint ${saveTone(saveState)}` }, saveState),
    ),
    h('p', { class: 'hint' },
      '存了立刻生效，不用重啟。金鑰寫在伺服器的資料目錄裡（DATA_DIR/settings.env，權限 600），' +
      '不會存在瀏覽器裡，也不會完整回傳到前端 —— 上面只看得到末四碼。'),
    h('p', { class: 'hint' },
      '留空表示不變更；要清除某個金鑰請輸入一個空格再儲存。'),
    h('p', { class: 'hint' },
      '只有你（擁有者）改得動：其他帳號連讀都會被伺服器擋掉。' +
      '如果 .env 裡也有同一個變數，這裡存的值會蓋掉它。'),
    serverStatusLine(),
  );
  return card;
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

// ─── 講評端點（換一個更快的模型）────────────────────────────────────────
//
// 為什麼值得放進設定頁：設定好 Azure 之後，實際練起來唯一有感的等待就是講評
// 那一段（分數一兩秒，Gemini 幾秒到十幾秒）。換成任何 OpenAI 相容的端點就會
// 快很多，而換的動作原本只能編輯 .env 再重啟 —— 手機上根本做不了。
//
// 四個一起設才會生效，缺一個會退回本地摘要。這張卡的順序就是照這件事排的。
function narrationCard() {
  const card = h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '講評端點（選用，換一個更快的模型）'),
    h('p', { class: 'hint' },
      '中文講評可以改走任何「OpenAI 相容」的 /chat/completions 端點 —— ' +
      'Hugging Face 的 Inference Providers、Groq、或自己機器上的 Ollama。' +
      '留空就是用 Gemini。'),
  );

  if (serverError || !serverSettings) return card;

  const provider = serverSettings.NARRATION_PROVIDER.value;
  const key = serverSettings.NARRATION_API_KEY;

  append(card,
    h('div', { class: 'field' },
      h('label', { class: 'field__label', for: 'narration-provider' }, '講評來源'),
      h('select', { class: 'field__input', id: 'narration-provider' },
        [
          ['', '自動（有 Gemini 金鑰就用 Gemini）'],
          ['gemini', 'Gemini'],
          ['openai', 'OpenAI 相容端點（下面三格）'],
          ['local', '只用本地摘要（完全不呼叫模型，最快）'],
        ].map(([value, label]) =>
          h('option', { value, selected: provider === value || null }, label)),
      ),
    ),
    field('端點 base URL', 'narration-base-url', {
      type: 'text',
      value: serverSettings.NARRATION_BASE_URL.value,
      placeholder: 'https://router.huggingface.co/v1',
      note: '填到 /v1 就好，/chat/completions 那一段伺服器會自己接。' +
        'Hugging Face 要用 router.huggingface.co（api-inference 那個舊端點有冷啟動，會更慢）。',
    }),
    field('端點金鑰', 'narration-key', {
      type: 'password',
      placeholder: key.configured ? `目前已設定（${key.preview}）` : '尚未設定',
      note: '供應商給的 token。Ollama 這種本機端點隨便填一個非空字串就行。',
    }),
    field('model', 'narration-model', {
      type: 'text',
      value: serverSettings.NARRATION_MODEL.value,
      placeholder: '照供應商列的 id 完整填',
      note: 'HF 的 router 可以在後面加「:供應商」指定要轉給誰（例如 :groq）。',
    }),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn--primary', onclick: saveNarration }, '儲存講評端點'),
      narrationSaveState &&
        h('span', { class: `hint ${saveTone(narrationSaveState)}` }, narrationSaveState),
    ),
    h('p', { class: 'hint' },
      '存了立刻生效。這條路失敗不會自動改打 Gemini —— 會退回本地摘要，' +
      '而上面那行「目前」就會寫出缺什麼或哪裡不通。'),
  );
  return card;
}

function saveTone(state) {
  if (state.startsWith('✅')) return 'hint--ok';
  if (state.startsWith('⚠️')) return 'hint--error';
  return '';   // 「儲存中…」「沒有變更」是中性訊息，不要標成錯誤
}

function field(label, id, { type = 'text', value = '', placeholder = '', note = '' } = {}) {
  return h('div', { class: 'field' },
    h('label', { class: 'field__label', for: id }, label),
    h('input', {
      class: 'field__input', id, type, value, placeholder,
      autocomplete: 'off', spellcheck: 'false',
    }),
    note && h('p', { class: 'hint' }, note),
  );
}

async function saveKeys() {
  const get = (id) => root?.querySelector(`#${id}`)?.value ?? '';
  const payload = {};

  const azureKey = get('azure-key');
  const azureRegion = get('azure-region');
  const geminiKey = get('gemini-key');

  // 空字串代表「不變更」；使用者輸入空白鍵才是「清除」
  if (azureKey !== '') payload.AZURE_SPEECH_KEY = azureKey.trim();
  if (geminiKey !== '') payload.GEMINI_API_KEY = geminiKey.trim();
  if (azureRegion !== (serverSettings?.AZURE_SPEECH_REGION.value ?? '')) {
    payload.AZURE_SPEECH_REGION = azureRegion.trim();
  }

  if (Object.keys(payload).length === 0) {
    saveState = '沒有變更';
    return render();
  }

  saveState = '儲存中…';
  render();
  saveState = await postSettings(payload);
  render();
}

async function saveNarration() {
  const get = (id) => root?.querySelector(`#${id}`)?.value ?? '';
  const payload = {};

  // 金鑰跟上面一樣是「空字串 = 不變更」；其餘三個是看得到目前值的欄位，
  // 所以用「跟目前不一樣才送」——那樣清空一個欄位才有辦法表達「清掉它」
  const key = get('narration-key');
  if (key !== '') payload.NARRATION_API_KEY = key.trim();

  for (const [id, envKey] of [
    ['narration-provider', 'NARRATION_PROVIDER'],
    ['narration-base-url', 'NARRATION_BASE_URL'],
    ['narration-model', 'NARRATION_MODEL'],
  ]) {
    const value = get(id).trim();
    if (value !== (serverSettings?.[envKey].value ?? '')) payload[envKey] = value;
  }

  if (Object.keys(payload).length === 0) {
    narrationSaveState = '沒有變更';
    return render();
  }

  narrationSaveState = '儲存中…';
  render();
  narrationSaveState = await postSettings(payload);
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
    if (body.capabilities) caps = body.capabilities;
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

    PRACTICE_MODES.map((mode) => h('div', { class: 'field' },
      h('label', { class: 'field__label', for: `goal-${mode.id}` },
        `${mode.icon} ${mode.label}`),
      h('div', { class: 'chips' },
        GOAL_CHOICES[mode.id].map((n) => toggleChip(
          `${n} ${mode.unit}`,
          (s.dailyGoals?.[mode.id] ?? 0) === n,
          () => { setGoal(mode.id, n); render(); },
        ))),
      h('input', {
        class: 'field__input', id: `goal-${mode.id}`, type: 'number', min: '0', max: '500',
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
function practiceCard() {
  const s = getSettings();

  return h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '練習偏好'),

    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, '只練這些情境'),
      h('div', { class: 'chips' }, CATEGORIES.map(([id, label]) =>
        toggleChip(label, s.categories.includes(id), () => {
          const next = s.categories.includes(id)
            ? s.categories.filter((c) => c !== id)
            : [...s.categories, id];
          updateSettings({ categories: next });
          render();
        }))),
      h('p', { class: 'hint' }, s.categories.length === 0 ? '目前：全部情境' : `目前：${s.categories.length} 個情境`),
    ),

    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, '只練這些難度'),
      h('div', { class: 'chips' }, DIFFICULTIES.map(([id, label]) =>
        toggleChip(label, s.difficulties.includes(id), () => {
          const next = s.difficulties.includes(id)
            ? s.difficulties.filter((d) => d !== id)
            : [...s.difficulties, id];
          updateSettings({ difficulties: next });
          render();
        }))),
      h('p', { class: 'hint' }, s.difficulties.length === 0 ? '目前：全部難度' : `目前：${s.difficulties.length} 種難度`),
    ),

    narrationField(s),

    models.length > 0 && h('div', { class: 'field' },
      h('label', { class: 'field__label', for: 'gemini-model' }, '講評用的 Gemini model'),
      h('select', {
        class: 'select', id: 'gemini-model',
        onchange: (e) => { updateSettings({ geminiModel: e.target.value }); render(); },
      }, models.map((m) => h('option', {
        value: m.id,
        selected: m.id === s.geminiModel,
      }, m.label ?? m.id))),
      h('p', { class: 'hint' },
        (models.find((m) => m.id === s.geminiModel)?.note ?? '') +
        '　清單寫死在後端，送上來的值也會再驗一次 —— 選單是 UI，不是權限。'),
    ),

    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, '單字卡的題型'),
      h('div', { class: 'chips' }, QUIZ_TYPES.map((t) =>
        toggleChip(t.label, s.vocabQuizTypes.includes(t.id), () => {
          const next = s.vocabQuizTypes.includes(t.id)
            ? s.vocabQuizTypes.filter((id) => id !== t.id)
            : [...s.vocabQuizTypes, t.id];
          updateSettings({ vocabQuizTypes: next });
          render();
        }))),
      h('p', { class: 'hint' },
        s.vocabQuizTypes.length === 0
          ? '一種都沒選 —— 會用翻卡（自己判斷記不記得）。'
          : `勾幾種就混哪幾種出題。選擇題是四選一，干擾項只會從同一級裡挑` +
            `跟答案完全不同義的字，所以不會出現兩個都對的選項。`),
    ),

    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, '中翻英題型'),
      h('div', { class: 'chips' },
        [['all', '兩種都要'], ['cloze', '只練填空'], ['sentence', '只練整句']].map(([id, label]) =>
          toggleChip(label, s.translationType === id, () => { updateSettings({ translationType: id }); render(); }))),
    ),
  );
}

/**
 * 中文講評的開關。
 *
 * 為什麼值得有這個開關：跟讀送出一次錄音要等兩段 —— Azure 給分數（快），
 * Gemini 把分數寫成中文建議（慢，實測幾秒到十幾秒，看 model）。
 * 想連著練十句的時候，後面那段就是純粹的等待，而分數與逐音素標色
 * 在沒有講評的情況下已經看得到了。關掉之後改用後端的本地摘要
 * （server/narration.js），一樣會指出最弱的面向與唸不好的字。
 */
function narrationField(s) {
  const on = s.geminiNarration !== false;
  const azure = caps?.azureConfigured === true;

  // 講評走哪一條路是**伺服器**決定的（NARRATION_PROVIDER），不是這裡。
  // 顯示它的唯一理由：改了設定卻沒生效時，「畫面上寫的跟實際跑的一樣」
  // 是使用者自己查得出問題的唯一方式 —— 不然只會覺得「換了還是一樣慢」。
  const narration = caps?.narration ?? null;

  return h('div', { class: 'field' },
    h('span', { class: 'field__label' }, '跟讀的中文講評'),
    h('div', { class: 'chips' },
      [[true, '要（AI 講評）'], [false, '不要（本地摘要，最快）']].map(([value, label]) =>
        toggleChip(label, on === value, () => {
          updateSettings({ geminiNarration: value });
          render();
        }))),
    h('p', { class: 'hint' },
      on
        ? '送出錄音後要多等講評那一段，換來「th 要把舌尖輕觸上齒」這種具體建議。'
        : '送出後直接看分數，講評改用本地摘要（照樣會指出最弱的面向與唸不好的字）。'),
    on && narration && narrationStatus(narration),
    !azure && h('p', { class: 'hint' },
      caps
        ? '⚠️ 目前沒有設定 Azure，跟讀的分數本身就是 Gemini 給的 —— ' +
          '這個開關要等設定了 Azure 金鑰才省得到時間。'
        : '（讀不到伺服器狀態，無法判斷目前的評分來源。）'),
  );
}

/**
 * 講評實際會走哪一條路。**這幾行讀的是伺服器狀態**，不是這台裝置的設定 ——
 * 上面那個開關只決定「要不要等講評」，走哪一條路是伺服器決定的。
 *
 * 擁有者可以在「講評端點」那張卡改；別人只看得到現在的狀態。
 */
function narrationStatus(narration) {
  const where = isOwner ? '上面的「講評端點」那張卡' : '伺服器的設定（要擁有者的帳號才改得動）';

  if (narration.id === 'local') {
    return h('p', { class: 'hint' },
      `目前設定成只用本地摘要（NARRATION_PROVIDER=local），不會呼叫任何模型。要改請看${where}。`);
  }
  if (!narration.ready) {
    return h('p', { class: 'hint hint--warn' },
      `⚠️ 講評設定成走 ${narration.label}，但${narration.problem} —— ` +
      `現在會退回本地摘要。請到${where}補上。`);
  }
  if (narration.id === 'openai') {
    return h('p', { class: 'hint' },
      `講評由 ${narration.label} 的 ${narration.model} 產生（要換請看${where}）。`);
  }
  return null;
}

function toggleChip(label, active, onclick) {
  return h('button', { class: 'togglechip' + (active ? ' togglechip--on' : ''), onclick }, label);
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

  const select = h('select', {
    class: 'field__input', id: 'voice',
    onchange: (e) => { updateSettings({ ttsVoice: e.target.value }); render(); },
  },
    h('option', { value: '' }, '自動挑選（優先 en-US）'),
    voices.map((v) => h('option', { value: v.name, selected: v.name === s.ttsVoice || null },
      `${v.name}（${v.lang}）`)),
  );

  return h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '語音'),
    h('div', { class: 'field' },
      h('label', { class: 'field__label', for: 'voice' }, `示範發音的聲音（找到 ${voices.length} 個英語語音）`),
      select,
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

  return h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '學習資料'),
    h('p', { class: 'hint' },
      `單字卡進度：${srsCount} 張有紀錄　|　跟讀紀錄：${historyCount} 筆　|　` +
      `每日紀錄：${activeDays} 天。` +
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
      '備份是一個 JSON 檔，包含複習進度、每日紀錄、跟讀紀錄與偏好設定（不含金鑰）。' +
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
