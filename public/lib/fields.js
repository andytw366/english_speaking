// 設定用的控制項。**同一種選擇一律長同一個樣子。**
//
// 為什麼要抽出來：這些控制項原本散在設定頁與各模式裡，同一種東西有兩三種樣子
// —— 「跟讀要不要加權抽句」是一個 checkbox（在跟讀模式裡），
// 「中文講評要不要」是一排 chip（在設定頁裡），而它們是同一種選擇：
// 一個選項，幾個互斥的值。長得不一樣的代價不是醜，是**使用者要重新學一次**：
// 看到 checkbox 會找「儲存」按鈕，看到 chip 才知道按下去就生效了。
//
// 規則很簡單：
//   互斥的幾個值（開／關、自動／手動／關、只練填空／只練整句）→ `chipField`
//   可複選（情境、難度、題型）→ `multiChipField`
//   要打字的（金鑰、網址、model id）→ `textField`
//   數字 → `numberField`
//   很長的清單（語音、model 白名單）→ `<select>`，那是唯一用得上 select 的地方

import { h } from './dom.js';

/**
 * 一顆會亮起來的選項。**按下去就生效**（沒有儲存按鈕）——
 * 這些都是存在瀏覽器裡的偏好，不是要送到伺服器的表單。
 */
export function toggleChip(label, active, onclick) {
  return h('button', {
    class: 'togglechip' + (active ? ' togglechip--on' : ''),
    'aria-pressed': active ? 'true' : 'false',
    onclick,
  }, label);
}

/**
 * 幾個互斥的值挑一個。
 *
 * @param {string} label 這個選項在問什麼
 * @param {Array<[unknown, string]>} options `[[值, 標籤], …]`
 * @param {unknown} current 目前的值
 * @param {(value: unknown) => void} onPick
 * @param {{hint?: string|Node, extra?: Node|null}} options2
 *   hint 是**選中的那個值**的說明 —— 每個值各講一句，而不是整組共用一句：
 *   「選了會怎樣」正是使用者按下去之前想知道的事
 */
export function chipField(label, options, current, onPick, { hint = '', extra = null } = {}) {
  return h('div', { class: 'field' },
    h('span', { class: 'field__label' }, label),
    h('div', { class: 'chips' },
      options.map(([value, text]) => toggleChip(text, current === value, () => onPick(value)))),
    hint && (typeof hint === 'string' ? h('p', { class: 'hint' }, hint) : hint),
    extra,
  );
}

/**
 * 可複選的那一種（空的通常代表「全部」，說明由呼叫端寫）。
 *
 * @param {Array<[unknown, string]>} options
 * @param {unknown[]} current
 * @param {(next: unknown[]) => void} onChange 收的是**改完之後的整個陣列**
 */
export function multiChipField(label, options, current, onChange, { hint = '' } = {}) {
  const chosen = Array.isArray(current) ? current : [];
  return h('div', { class: 'field' },
    h('span', { class: 'field__label' }, label),
    h('div', { class: 'chips' },
      options.map(([value, text]) => toggleChip(text, chosen.includes(value), () => {
        onChange(chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value]);
      }))),
    hint && h('p', { class: 'hint' }, hint),
  );
}

/**
 * 要打字的欄位。**這一種才有「儲存」按鈕**（呼叫端自己畫）——
 * 打字中的每一個字都送出去是沒有意義的。
 */
export function textField(label, id, { type = 'text', value = '', placeholder = '', note = '' } = {}) {
  return h('div', { class: 'field' },
    h('label', { class: 'field__label', for: id }, label),
    h('input', {
      class: 'field__input', id, type, value, placeholder,
      autocomplete: 'off', spellcheck: 'false',
    }),
    note && h('p', { class: 'hint' }, note),
  );
}

/** 數字。跟 chipField 一樣是即時生效的。 */
export function numberField(label, id, { value = 0, min = 0, max = 500, onChange, note = '' } = {}) {
  return h('div', { class: 'field' },
    h('label', { class: 'field__label', for: id }, label),
    h('input', {
      class: 'field__input', id, type: 'number',
      min: String(min), max: String(max), value: String(value),
      onchange: (e) => onChange?.(e.target.value),
    }),
    note && h('p', { class: 'hint' }, note),
  );
}

/**
 * 很長的清單。**只有清單長到 chip 排不下才用**（語音可能有幾十個、
 * model 白名單有五個以上）—— 三四個選項用 select 的話，
 * 使用者要多按一下才看得到自己有哪些選擇。
 */
export function selectField(label, id, options, current, onPick, { note = '' } = {}) {
  return h('div', { class: 'field' },
    h('label', { class: 'field__label', for: id }, label),
    h('select', {
      class: 'field__input', id,
      // onPick 可以不給：**要跟旁邊的欄位一起按「儲存」送出**的選單，
      // 值是存檔時從 DOM 讀的（那幾個是伺服器設定，改一個就送出去沒有意義）
      onchange: onPick ? (e) => onPick(e.target.value) : null,
    }, options.map(([value, text]) =>
      h('option', { value, selected: value === current || null }, text))),
    note && h('p', { class: 'hint' }, note),
  );
}
