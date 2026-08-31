// 應用外殼：模式切換與共用錯誤處理。各模式自己負責內容。
import { h, clear } from './lib/dom.js';

const MODES = ['vocabulary', 'listening', 'translation', 'dialogue', 'shadowing', 'settings'];

const nav = document.getElementById('nav');
const view = document.getElementById('view');
const subtitle = document.getElementById('subtitle');

const SUBTITLE = {
  vocabulary: '用間隔重複記單字 —— 答對的字會隔更久才再出現。',
  listening: '先聽，再作答。聽不出來可以看原文。',
  translation: '看中文寫英文 —— 填空練用字，整句練組織。',
  dialogue: '角色扮演 —— 對方由語音扮演，你依中文意圖說出自己的台詞。',
  shadowing: '聽示範發音，錄下自己的版本，比對差在哪。',
  settings: '金鑰、練習範圍、語音與學習資料。',
};

let loaded = {};      // id -> module
let cleanup = null;
let currentMode = null;

async function switchTo(id) {
  if (id === currentMode) return;

  try { cleanup?.(); } catch (err) { console.error('[cleanup]', err); }
  cleanup = null;
  currentMode = id;

  // 記住上次用的模式
  try { localStorage.setItem('speaking-coach:mode', id); } catch { /* 私密瀏覽，忽略 */ }

  renderNav();
  subtitle.textContent = SUBTITLE[id] ?? '';
  clear(view);
  view.append(h('p', { class: 'hint' }, '載入中…'));

  try {
    if (!loaded[id]) loaded[id] = await import(`./modes/${id}.js`);
    clear(view);
    cleanup = await loaded[id].mount(view);
  } catch (err) {
    console.error(`[mode:${id}]`, err);
    clear(view);
    view.append(
      h('div', { class: 'banner banner--error' },
        `載入「${id}」時發生問題：${err.message}\n` +
        '請確認後端有在執行（npm start），然後重新整理頁面。'),
    );
  }
}

function renderNav() {
  clear(nav);
  for (const id of MODES) {
    const mod = loaded[id];
    const label = mod?.meta?.label ?? DEFAULT_LABEL[id];
    const icon = mod?.meta?.icon ?? DEFAULT_ICON[id];
    nav.append(
      h('button', {
        class: 'tab' + (id === currentMode ? ' tab--active' : ''),
        onclick: () => switchTo(id),
        'aria-current': id === currentMode ? 'page' : null,
      }, `${icon} ${label}`),
    );
  }
}

// 模組還沒載入前 nav 就要畫得出來，所以標籤先寫死一份
const DEFAULT_LABEL = { vocabulary: '單字卡', listening: '聽力', translation: '中翻英', dialogue: '情境對話', shadowing: '跟讀', settings: '設定' };
const DEFAULT_ICON = { vocabulary: '🗂️', listening: '🎧', translation: '✍️', dialogue: '💬', shadowing: '🗣️', settings: '⚙️' };

let saved = null;
try { saved = localStorage.getItem('speaking-coach:mode'); } catch { /* 忽略 */ }
switchTo(MODES.includes(saved) ? saved : 'vocabulary');
