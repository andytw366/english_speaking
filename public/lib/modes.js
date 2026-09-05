// 六個模式的登錄表：標籤、圖示、副標題、以及每日進度的單位。
//
// **為什麼要有這一份**：這些字串原本散在三個地方 —— `app.js` 的 `DEFAULT_LABEL`
// 與 `DEFAULT_ICON`（模組還沒載入前 nav 就要畫得出來，所以先寫死一份）、
// 每個模式自己的 `meta`、以及各模式裡的「今天練的○○」。
// 首頁要一次列出全部模式，等於第四份 —— 與其再抄一次，不如收成一份。
//
// 每個模式自己的 `meta` 留著（模組載入後 nav 會用它覆蓋），這裡是它載入前的樣子。

export const MODES = [
  {
    id: 'home',
    label: '今天',
    icon: '🏠',
    subtitle: '今天練了多少、還差多少，以及有幾個字該複習了。',
    // 沒有 unit：首頁自己不累積進度，它只是把別的模式的進度放在一起
    keys: [['1–5', '跳到那個模式']],
  },
  {
    id: 'vocabulary',
    label: '單字卡',
    icon: '🗂️',
    subtitle: '用間隔重複記單字 —— 答對的字會隔更久才再出現。',
    // 每日進度的單位。有 unit 的模式才算進「今天練了什麼」
    unit: '個字',
    todayLabel: '今天練的字',
    keys: [['1–4', '選答案'], ['Enter', '下一題'], ['空白', '翻卡・下一步'], ['S', '唸一次']],
  },
  {
    id: 'listening',
    label: '聽力',
    icon: '🎧',
    subtitle: '先聽，再作答。聽不出來可以看原文。',
    // 單位是「組」：一段錄音配 2～6 題，題目綁在同一段錄音上、不能分開練，
    // 所以真正的練習單位是一整組。照題數算的話同樣練完一組，
    // 數字跳多少要看運氣（+2 還是 +6），「今天練了 12」講不出練了多少東西。
    unit: '組',
    todayLabel: '今天練的題組',
    keys: [['P', '播放'], ['1–4', '作答'], ['Enter', '對答案・下一題'], ['N', '換一題']],
  },
  {
    id: 'translation',
    label: '中翻英',
    icon: '✍️',
    subtitle: '看中文寫英文 —— 填空練用字，整句練組織。',
    unit: '題',
    todayLabel: '今天練的題',
    keys: [['⌘/Ctrl+Enter', '對答案'], ['Enter', '下一題']],
  },
  {
    id: 'dialogue',
    label: '情境對話',
    icon: '💬',
    subtitle: '角色扮演 —— 對方由語音扮演，你依中文意圖說出自己的台詞。',
    unit: '句',
    todayLabel: '今天說的台詞',
    keys: [['⌘/Ctrl+Enter', '對答案'], ['Enter', '繼續'], ['P', '再聽一次']],
  },
  {
    id: 'shadowing',
    label: '跟讀',
    icon: '🗣️',
    subtitle: '聽示範發音，錄下自己的版本，比對差在哪。',
    unit: '句',
    todayLabel: '今天練的句子',
    keys: [['空白', '開始・停止錄音'], ['P', '播放範例'], ['N', '換一句']],
  },
  {
    id: 'settings',
    label: '設定',
    icon: '⚙️',
    subtitle: '金鑰、每日目標、練習範圍、語音與學習資料。',
  },
];

// `keys` 是給左側模式列的快捷鍵提示用的（手機沒有鍵盤，所以只在桌機出現）。
// 快捷鍵本身在各模式自己的 onKey()，這裡只是**說明** —— 兩邊不同步的症狀是
// 「畫面上寫的鍵按了沒反應」，改快捷鍵的時候記得回來改這一行。

/** 會累積每日進度的模式（設定頁不算）。順序就是畫面上的順序。 */
export const PRACTICE_MODES = MODES.filter((m) => m.unit);

export const MODE_IDS = MODES.map((m) => m.id);

export function modeMeta(id) {
  return MODES.find((m) => m.id === id) ?? { id, label: id, icon: '', subtitle: '' };
}
