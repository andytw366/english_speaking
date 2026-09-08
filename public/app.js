// 應用外殼：模式切換與共用錯誤處理。各模式自己負責內容。
//
// 版面是三區的（見 index.html）：桌機是「左側模式列 ｜ 練習區 ｜ 輔助欄」，
// 手機是「練習區 ＋ 下方模式列」。同一份 `renderNav()` 同時畫左側與下方兩份，
// 由 CSS 決定哪一份出現 —— 兩份各自維護的話，加一個模式就會有一邊忘了加。
import { h, clear, append } from './lib/dom.js';
import { single } from './lib/layout.js';
import { MODES, MODE_IDS, GLOBAL_KEYS, modeMeta } from './lib/modes.js';
import { overallToday } from './lib/daily.js';
import { setUnauthenticatedHandler, whoAmI } from './lib/session.js';
import { renderLogin } from './lib/login-view.js';
import { start as startSync } from './lib/sync.js';
import { bindKeys } from './lib/keys.js';

const nav = document.getElementById('nav');
const dock = document.getElementById('dock');
const view = document.getElementById('view');
const subtitle = document.getElementById('subtitle');
const pageTitle = document.getElementById('pageTitle');
const railToday = document.getElementById('railToday');
const railKeys = document.getElementById('railKeys');
const gear = document.getElementById('gear');
const helpBtn = document.getElementById('helpBtn');
const footHelp = document.getElementById('footHelp');

/**
 * 螢幕下方那一列放得下的模式：設定與說明不放（它們在頁首的兩顆按鈕）。
 *
 * 手機那一列一格塞得下一個圖示加兩三個中文字，五格剛好；
 * 多一格就開始擠成兩行，而那兩個都不是每天要按的東西。
 */
const DOCK_MODES = MODES.filter((m) => m.id !== 'settings' && m.id !== 'help');

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

  for (const [button, id] of [[gear, 'settings'], [helpBtn, 'help']]) {
    if (!button) continue;
    button.classList.toggle('page__gear--active', currentMode === id);
    button.setAttribute('aria-current', currentMode === id ? 'page' : 'false');
  }
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
const RAIL_KEYS = 4;

function renderKeys(meta) {
  if (!railKeys) return;
  clear(railKeys);
  const keys = meta.keys ?? [];
  railKeys.hidden = false;

  append(railKeys,
    h('p', { class: 'railkeys__title' }, '鍵盤'),
    // 側欄只放最常按的幾個 —— 列滿七行的話它會比練習區還高，
    // 而那幾行每一題都在那裡，看第二次就是雜訊了
    keys.slice(0, RAIL_KEYS).map(([key, what]) => keyRow(key, what)),
    h('button', {
      class: 'railkeys__more',
      onclick: () => toggleKeyHelp(true),
    }, keys.length > RAIL_KEYS ? `全部 ${keys.length} 個（?）` : '全部快捷鍵（?）'),
  );
}

function keyRow(key, what) {
  return h('div', { class: 'railkeys__row' },
    h('kbd', { class: 'kbd' }, key),
    h('span', { class: 'railkeys__what' }, what),
  );
}

/**
 * 快捷鍵說明面板（按 `?`）。
 *
 * 為什麼需要它而不是只有側欄那幾行：側欄放得下四行，而每個模式現在有五到七個
 * 鍵、還有四個全域的。**快捷鍵最大的問題不是難按，是沒人知道有這個東西** ——
 * 側欄那幾行負責「讓人知道有」，這張表負責「一次看完」。
 *
 * 手機上不會出現（沒有鍵盤），跟側欄同一個理由。
 */
let keyHelpOpen = false;

function toggleKeyHelp(open = !keyHelpOpen) {
  keyHelpOpen = open;
  const existing = document.getElementById('keyhelp');
  existing?.remove();
  if (!open) return;

  const meta = modeMeta(currentMode);
  const panel = h('div', {
    class: 'keyhelp', id: 'keyhelp', role: 'dialog', 'aria-label': '鍵盤快捷鍵',
    // 點背景關掉。點面板本身不關 —— 使用者會想選字
    onclick: (e) => { if (e.target.id === 'keyhelp') toggleKeyHelp(false); },
  },
    h('div', { class: 'keyhelp__card' },
      h('div', { class: 'keyhelp__head' },
        h('p', { class: 'card__title' }, '鍵盤快捷鍵'),
        h('button', { class: 'btn btn--ghost', onclick: () => toggleKeyHelp(false) }, '關閉（Esc）'),
      ),
      h('p', { class: 'keyhelp__group' }, `${meta.icon} ${meta.label}`),
      (meta.keys ?? []).length
        ? (meta.keys ?? []).map(([key, what]) => keyRow(key, what))
        : h('p', { class: 'hint' }, '這個模式沒有快捷鍵。'),
      h('p', { class: 'keyhelp__group' }, '不分模式'),
      GLOBAL_KEYS.map(([key, what]) => keyRow(key, what)),
      h('p', { class: 'hint' },
        '打字的時候一律不接（中翻英、情境對話、設定裡的欄位）—— ' +
        '不然打一個 n 就換題了。中文輸入法組字中也不接。'),
    ),
  );
  document.body.append(panel);
}

gear.addEventListener('click', () => switchTo('settings'));
helpBtn?.addEventListener('click', () => switchTo('help'));
footHelp?.addEventListener('click', () => switchTo('help'));

/**
 * 全域快捷鍵。**綁在外殼、而且在模式之前收到鍵** ——
 * 模式自己的 onKey 收到的是它沒接走的那些。
 *
 * 為什麼是 `[` `]` 而不是數字鍵換模式：數字在四個模式裡是「選第幾個選項」，
 * 搶過來的話作答會變成換分頁。
 */
bindKeys((key, event) => {
  if (key === 'escape') {
    if (!keyHelpOpen) return false;
    toggleKeyHelp(false);
    return true;
  }
  // `?` 在多數鍵盤上要按 shift，所以 key 直接就是 '?'
  if (key === '?' || (key === '/' && event.shiftKey)) { toggleKeyHelp(); return true; }
  if (key === '[' || key === ']') {
    const ids = MODE_IDS;
    const at = ids.indexOf(currentMode);
    if (at < 0) return false;
    const next = key === ']' ? (at + 1) % ids.length : (at - 1 + ids.length) % ids.length;
    switchTo(ids[next]);
    return true;
  }
  return false;
});

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

/**
 * 進 App 之前先確認登入。
 *
 * 為什麼是「先問再畫」而不是「先畫，錯了再說」：模式模組一掛上去就會抓題庫，
 * 沒登入的話那些請求全都是 401，使用者會先看到六種各自的載入失敗訊息，
 * 沒有人猜得到那其實是「要登入」。
 */
async function boot() {
  // 明確知道離線時就省下這一次請求。
  //
  // ⚠️ **這只是省事，不是防線** —— `navigator.onLine` 在某些 Chromium 版本下
  // 不會跟著離線變成 false（CI 的版本就是這樣，所以本機全過、CI 紅）。
  // 真正擋掉「離線時 console 出現紅色錯誤」的是 `sw.js` 的 `auth-probe`：
  // 它把連不上換成一個 503 回應。
  if (navigator.onLine === false) return enterApp();

  let state;
  try {
    state = await whoAmI();
  } catch (err) {
    // 連不到伺服器（離線、伺服器掛了）。**不要卡在登入畫面** ——
    // 題庫與進度都在快取與 localStorage 裡，照樣練得起來
    console.warn('[auth] 問不到登入狀態，先照常開啟：', err.message);
    return enterApp();
  }

  if (state.user) return enterApp();
  showLogin(state);
}

function showLogin(state) {
  document.body.classList.add('locked');
  // 標題要跟卡片上寫的一致 —— 第一次開啟時卡片是「建立第一個帳號」，
  // 標題卻寫「登入」的話，看起來像跑錯畫面
  pageTitle.textContent = state.firstRun ? '🔐 建立帳號' : '🔐 登入';
  subtitle.textContent = state.firstRun
    ? '這台伺服器還沒有帳號。建立一個之後，練習進度就會存在上面。'
    : '練習進度存在伺服器上，登入之後每一台裝置看到的是同一份。';
  railKeys.hidden = true;
  // 走 single() 而不是 clear()：`#view` 上可能還留著上一個畫面的分欄類別
  // （README 的雷單有這一條）。留著的話登入卡會被擠成窄窄一條
  renderLogin(single(view), { ...state, onDone: () => enterApp() });
}

function enterApp() {
  document.body.classList.remove('locked');
  currentMode = null;   // 從登入畫面回來時要真的重畫一次
  let saved = null;
  try { saved = localStorage.getItem('speaking-coach:mode'); } catch { /* 忽略 */ }
  // 沒有上次用的模式就落在首頁 —— 打開 App 的第一個問題是「我今天該做什麼」
  switchTo(MODE_IDS.includes(saved) ? saved : 'home');

  // 自動同步。**先畫再同步**，不是先同步再畫 ——
  // 同步要等一次網路往返，而離線時那一次永遠不會回來；擋在畫面前面的話
  // 使用者會對著空白畫面等，而他其實已經可以開始練了。
  //
  // 合併之後如果本機的資料真的被改過（另一台裝置練過），重畫一次讓數字跟上。
  startSync().then(({ merged }) => {
    if (!merged) return;
    renderToday();
    // 模式模組在 mount 時就把資料讀進自己的狀態了，所以要重掛一次才看得到
    const mode = currentMode;
    currentMode = null;
    switchTo(mode);
  }).catch((err) => {
    // start() 自己已經吞掉同步失敗了，這裡只擋意外
    console.warn('[sync] 啟動自動同步時出錯：', err?.message);
  });
}

// session 過期（30 天）之後每一個請求都會回 401。沒有這一段的話，
// 使用者看到的是各模式各自的載入失敗，而且**重新整理也不會好**
setUnauthenticatedHandler(() => {
  if (document.body.classList.contains('locked')) return;   // 已經在登入畫面了
  try { cleanup?.(); } catch { /* 忽略 */ }
  cleanup = null;
  showLogin({ firstRun: false, canRegister: false });
});

boot();
