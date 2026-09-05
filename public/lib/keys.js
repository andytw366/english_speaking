// 鍵盤操作。
//
// 桌機上一題現在整頁看得完（版面改版之後不必捲），剩下的就是不要摸滑鼠 ——
// 練 20 個字等於 40 次「移動滑鼠 → 瞄準 → 點」，而鍵盤是 20 次按鍵。
//
// 為什麼要一個共用模組而不是各模式自己 addEventListener：**要擋掉的情況比要接的
// 還多**，而且每一種擋不掉都是真的 bug：
//
//   1. **正在打字**（中翻英、情境對話、設定裡的金鑰欄）—— 不擋的話打一個 n
//      就換題，輸入到一半的答案直接消失
//   2. **中文輸入法組字中** —— 注音打「ㄋ」的時候 keydown 的 key 是組字用的鍵，
//      `isComposing` 為 true。不擋的話用中文輸入法的人整個 App 都會亂跳
//   3. **焦點在按鈕或連結上** —— Enter 與空白鍵本來就會觸發它，再接一次等於
//      按了兩下（「換一句」會連跳兩句）
//   4. **有按修飾鍵** —— Ctrl+R 重新整理、⌘+L 跳網址列，這些一律讓給瀏覽器
//
// 模式只要回答「這個鍵我要不要接」，這四種情況它們都不必自己想。

/** 這些元素一律不接：使用者正在裡面打字。 */
const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** 瀏覽器自己就會用這兩個鍵觸發按鈕與連結，接了會變成按兩下。 */
const NATIVE_ACTIVATION = new Set(['enter', 'space']);

/**
 * 綁定鍵盤操作，回傳解除綁定的函式（模式的 cleanup 要呼叫它）。
 *
 * @param {(key: string, event: KeyboardEvent) => boolean|void} handler
 *   key 已經正規化：一律小寫，空白鍵是 `'space'`，Enter 是 `'enter'`。
 *   **回傳 `true` 表示「我處理了」**，這時才會 `preventDefault()`
 *   —— 沒處理的鍵要留給瀏覽器（空白鍵捲頁面、Tab 走訪焦點）。
 */
export function bindKeys(handler) {
  const onKeyDown = (event) => {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // keyCode 229 是還沒有 isComposing 的舊瀏覽器表示「組字中」的方式
    if (event.isComposing || event.keyCode === 229) return;

    const target = event.target;
    if (TYPING.has(target?.tagName) || target?.isContentEditable) return;

    const key = normalize(event);
    if (!key) return;
    if (NATIVE_ACTIVATION.has(key) && target?.closest?.('button, a[href]')) return;

    if (handler(key, event) === true) event.preventDefault();
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

/** 一律小寫；空白鍵給一個念得出來的名字，不然 map 裡會出現看不見的 `' '`。 */
function normalize(event) {
  if (event.key === ' ' || event.code === 'Space') return 'space';
  if (typeof event.key !== 'string' || event.key.length > 11) return '';
  return event.key.toLowerCase();
}

/**
 * 「1」～「9」轉成陣列索引，不是數字就回 -1。
 *
 * 各模式都要把 `'3'` 換成 `options[2]`，寫在這裡才不會有人少檢查一次範圍
 * —— 少檢查的症狀是按 `5` 時拿到 `undefined`，畫面直接空掉。
 */
export function indexOfKey(key, length) {
  if (!/^[1-9]$/.test(key)) return -1;
  const i = Number(key) - 1;
  return i < length ? i : -1;
}
