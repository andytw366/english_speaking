// 應用外殼：模式切換與共用錯誤處理。各模式自己負責內容。
import { h, clear } from './lib/dom.js';
import { MODES, MODE_IDS, modeMeta } from './lib/modes.js';

const nav = document.getElementById('nav');
const view = document.getElementById('view');
const subtitle = document.getElementById('subtitle');

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
  subtitle.textContent = modeMeta(id).subtitle;
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
  for (const { id, label: fallbackLabel, icon: fallbackIcon } of MODES) {
    const mod = loaded[id];
    // 模組還沒載入前 nav 就要畫得出來，所以標籤先用登錄表裡的那一份
    const label = mod?.meta?.label ?? fallbackLabel;
    const icon = mod?.meta?.icon ?? fallbackIcon;
    nav.append(
      h('button', {
        class: 'tab' + (id === currentMode ? ' tab--active' : ''),
        onclick: () => switchTo(id),
        'aria-current': id === currentMode ? 'page' : null,
      }, `${icon} ${label}`),
    );
  }
}

// 首頁（或別的模式）要跳到某個模式時發這個事件。
// 反過來讓模式模組 import app.js 會變成循環相依 —— 模式是 app.js 動態載入的。
window.addEventListener('switch-mode', (e) => {
  if (MODE_IDS.includes(e.detail)) switchTo(e.detail);
});

let saved = null;
try { saved = localStorage.getItem('speaking-coach:mode'); } catch { /* 忽略 */ }
// 沒有上次用的模式就落在首頁 —— 打開 App 的第一個問題是「我今天該做什麼」
switchTo(MODE_IDS.includes(saved) ? saved : 'home');
