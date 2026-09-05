// 應用外殼：模式切換與共用錯誤處理。各模式自己負責內容。
//
// 版面是三區的（見 index.html）：桌機是「左側模式列 ｜ 練習區 ｜ 輔助欄」，
// 手機是「練習區 ＋ 下方模式列」。同一份 `renderNav()` 同時畫左側與下方兩份，
// 由 CSS 決定哪一份出現 —— 兩份各自維護的話，加一個模式就會有一邊忘了加。
import { h, clear, append } from './lib/dom.js';
import { MODES, MODE_IDS, modeMeta } from './lib/modes.js';
import { overallToday } from './lib/daily.js';

const nav = document.getElementById('nav');
const dock = document.getElementById('dock');
const view = document.getElementById('view');
const subtitle = document.getElementById('subtitle');
const pageTitle = document.getElementById('pageTitle');
const railToday = document.getElementById('railToday');
const railKeys = document.getElementById('railKeys');
const gear = document.getElementById('gear');

/** 螢幕下方那一列放得下的模式：設定不放（它在頁首的齒輪）。 */
const DOCK_MODES = MODES.filter((m) => m.id !== 'settings');

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
  renderToday();
  const meta = modeMeta(id);
  renderKeys(meta);
  pageTitle.textContent = `${meta.icon} ${meta.label}`.trim();
  subtitle.textContent = meta.subtitle;
  clear(view);
  // 上一個模式如果用了輔助欄，換模式時要收回來 —— 下一個模式自己會再開
  view.className = '';
  view.append(h('p', { class: 'hint' }, '載入中…'));
  // 切模式一律回到最上面：上一個模式捲到一半的位置對新畫面沒有意義
  window.scrollTo({ top: 0 });

  try {
    if (!loaded[id]) loaded[id] = await import(`./modes/${id}.js`);
    clear(view);
    view.className = '';
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
  clear(dock);

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

    if (!DOCK_MODES.some((m) => m.id === id)) continue;
    dock.append(
      h('button', {
        class: 'dock__btn' + (id === currentMode ? ' dock__btn--active' : ''),
        onclick: () => switchTo(id),
        'aria-current': id === currentMode ? 'page' : null,
      },
        h('span', { class: 'dock__icon' }, icon),
        h('span', { class: 'dock__label' }, label),
      ),
    );
  }

  gear.classList.toggle('page__gear--active', currentMode === 'settings');
  gear.setAttribute('aria-current', currentMode === 'settings' ? 'page' : 'false');
}

/**
 * 左側常駐的「今天」：跨模式的總數與連續天數。
 *
 * 放在外殼而不是各模式裡的理由：它在**每一個**模式都成立，而且不會因為
 * 切模式就重算一次意思 —— 首頁的那張大卡是同一組數字的詳細版。
 */
function renderToday() {
  if (!railToday) return;
  const { total, streak } = overallToday();
  clear(railToday);
  append(railToday,
    h('div', { class: 'railstat' },
      h('span', { class: 'railstat__value' }, String(total)),
      h('span', { class: 'railstat__label' }, '今天練了'),
    ),
    h('div', { class: 'railstat' },
      h('span', { class: 'railstat__value' }, String(streak)),
      h('span', { class: 'railstat__label' }, '連續天數'),
    ),
  );
}

/**
 * 這個模式有哪些快捷鍵。
 *
 * 放在側欄的理由：快捷鍵最大的問題不是難按，是**沒人知道有這個東西**。
 * 放在卡片上會變成每一題都在講同一件事，放在說明頁等於沒放。側欄是常駐的，
 * 而且只在桌機出現 —— 手機沒有鍵盤，那裡連側欄都不會畫出來。
 *
 * 文字來自 `lib/modes.js` 的 `keys`，實作在各模式的 `onKey()`。**兩邊要一起改**。
 */
function renderKeys(meta) {
  if (!railKeys) return;
  clear(railKeys);
  const keys = meta.keys ?? [];
  railKeys.hidden = keys.length === 0;
  if (keys.length === 0) return;

  append(railKeys,
    h('p', { class: 'railkeys__title' }, '鍵盤'),
    keys.map(([key, what]) => h('div', { class: 'railkeys__row' },
      h('kbd', { class: 'kbd' }, key),
      h('span', { class: 'railkeys__what' }, what),
    )),
  );
}

gear.addEventListener('click', () => switchTo('settings'));

// 首頁（或別的模式）要跳到某個模式時發這個事件。
// 反過來讓模式模組 import app.js 會變成循環相依 —— 模式是 app.js 動態載入的。
window.addEventListener('switch-mode', (e) => {
  if (MODE_IDS.includes(e.detail)) switchTo(e.detail);
});

// 練了一次、或改了每日目標，左側那兩個數字要跟著動
window.addEventListener('practice-recorded', renderToday);
window.addEventListener('settings-changed', renderToday);

/**
 * 註冊 service worker：加到主畫面、以及沒有網路也打得開。
 *
 * **失敗只 warn 不 error**：service worker 是加分項，裝不起來（不支援、
 * 使用者關掉、非 secure context）時整個 App 照樣能用 —— 為了它在 console 留下
 * 一筆紅色錯誤，只會讓真正的錯誤更難被看見。
 *
 * secure context 才註冊得起來，而區網 IP 不算 —— 跟麥克風是同一條限制
 * （見 README「憑證：兩條路」）。
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[sw] 沒有註冊成功，不影響使用：', err.message);
    });
  });
}

let saved = null;
try { saved = localStorage.getItem('speaking-coach:mode'); } catch { /* 忽略 */ }
// 沒有上次用的模式就落在首頁 —— 打開 App 的第一個問題是「我今天該做什麼」
switchTo(MODE_IDS.includes(saved) ? saved : 'home');
