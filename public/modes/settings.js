import { h, clear, append } from '../lib/dom.js';
import { loadVoices, speak } from '../lib/tts.js';
import { getSettings, updateSettings, resetSettings, DEFAULTS } from '../lib/settings.js';
import { resetSrs, clearHistory, getHistory, getSrsState } from '../lib/storage.js';
import { CATEGORY_LABEL, DIFFICULTY_LABEL, DIFFICULTY_ORDER } from '../lib/labels.js';

export const meta = { id: 'settings', label: '設定', icon: '⚙️' };

// 情境與難度的清單從 lib/labels.js 長出來，不在這裡再寫死一份 ——
// 句庫已經有八種情境（原本這裡只列四種，新增的四種就選不到）。
const CATEGORIES = Object.entries(CATEGORY_LABEL);
const DIFFICULTIES = DIFFICULTY_ORDER.map((id) => [id, DIFFICULTY_LABEL[id]]);

let voices = [];
let models = [];
let serverSettings = null;
let serverError = '';
let saveState = '';
let root = null;

export async function mount(container) {
  root = container;
  voices = (await loadVoices()).filter((v) => v.lang?.startsWith('en'));

  try {
    const res = await fetch('/api/settings');
    const body = await res.json();
    if (!res.ok) serverError = body?.message ?? `HTTP ${res.status}`;
    else serverSettings = body;
  } catch (err) {
    serverError = '讀不到伺服器設定，請確認後端還在執行。';
  }

  // model 清單拿不到不是致命錯誤 —— 收起選單，讓後端用它的預設值就好
  try {
    const res = await fetch('/api/models');
    const body = await res.json();
    models = Array.isArray(body.models) ? body.models : [];
  } catch {
    models = [];
  }

  render();
  return () => { root = null; };
}

function render() {
  if (!root) return;
  clear(root);
  append(root, apiCard(), practiceCard(), voiceCard(), dataCard());
}

// ─── API 金鑰 ────────────────────────────────────────────────────────────
function apiCard() {
  const card = h('div', { class: 'card' },
    h('p', { class: 'card__title' }, 'API 金鑰（發音評分用）'),
    h('p', { class: 'hint' },
      '這些是選用的 —— 不填也能正常使用單字卡、聽力與中翻英，跟讀也還是可以錄音比對。'),
  );

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
      saveState && h('span', { class: `hint ${saveTone()}` }, saveState),
    ),
    h('p', { class: 'hint' },
      '金鑰會寫進伺服器的 .env（權限 600），不會存在瀏覽器裡，也不會完整回傳到前端。' +
      '留空表示不變更；要清除某個金鑰請輸入一個空格再儲存。'),
    h('p', { class: 'hint hint--warn' },
      '⚠️ 這個設定頁只接受從 localhost 發出的請求。如果之後要把這個 App 部署到網路上，' +
      '必須先移除 /api/settings 端點 —— 否則任何人都能改你的金鑰。'),
  );
  return card;
}

function saveTone() {
  if (saveState.startsWith('✅')) return 'hint--ok';
  if (saveState.startsWith('⚠️')) return 'hint--error';
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

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) {
      saveState = `⚠️ ${body?.message ?? `HTTP ${res.status}`}`;
    } else {
      serverSettings = body.settings;
      saveState = '✅ 已儲存，立即生效（不用重啟）';
    }
  } catch (err) {
    saveState = '⚠️ 連不上伺服器';
  }
  render();
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
      h('label', { class: 'field__label', for: 'session-limit' }, '單字卡一輪最多幾張'),
      h('input', {
        class: 'field__input', id: 'session-limit', type: 'number', min: '0', max: '200',
        value: String(s.sessionLimit),
        onchange: (e) => { updateSettings({ sessionLimit: Math.max(0, Number(e.target.value) || 0) }); render(); },
      }),
      h('p', { class: 'hint' }, '0 表示不限制。'),
    ),

    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, '中翻英題型'),
      h('div', { class: 'chips' },
        [['all', '兩種都要'], ['cloze', '只練填空'], ['sentence', '只練整句']].map(([id, label]) =>
          toggleChip(label, s.translationType === id, () => { updateSettings({ translationType: id }); render(); }))),
    ),
  );
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

// ─── 學習資料 ────────────────────────────────────────────────────────────
function dataCard() {
  const srsCount = Object.keys(getSrsState()).length;
  const historyCount = getHistory().length;

  return h('div', { class: 'card' },
    h('p', { class: 'card__title' }, '學習資料'),
    h('p', { class: 'hint' },
      `單字卡進度：${srsCount} 張有紀錄　|　跟讀紀錄：${historyCount} 筆。` +
      '這些都存在這個瀏覽器的 localStorage，換瀏覽器或清除瀏覽資料就會消失。'),
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
        onclick: () => confirmThen('確定要把所有偏好設定恢復成預設值嗎？（不影響金鑰）',
          () => { resetSettings(); render(); }),
      }, '恢復預設設定'),
    ),
  );
}

function confirmThen(message, fn) {
  if (window.confirm(message)) fn();
}
