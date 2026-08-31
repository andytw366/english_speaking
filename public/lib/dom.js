/**
 * 極簡的元素建構工具，避免各模式充滿 createElement 樣板。
 * 一律用 textContent 設定文字，不碰 innerHTML。
 *
 *   h('button', { class: 'btn', onclick: fn }, '送出')
 *   h('div', { class: 'row' }, h('span', {}, '文字'), otherElement)
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value);
    } else if (key === 'class') {
      el.className = value;
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'disabled' || key === 'hidden') {
      el[key] = Boolean(value);
    } else {
      el.setAttribute(key, value);
    }
  }

  // 深層攤平：map() 回傳巢狀陣列（例如 [元素, ' '] 的清單）時，
  // 只攤一層會讓內層陣列被當成文字，印出 [object HTMLSpanElement]。
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
}

/**
 * 把 children 掛到既有元素上，規則跟 `h()` 完全一樣（過濾 null／false、深層攤平）。
 *
 * **為什麼需要它**：`h()` 會過濾掉 `false`，但直接呼叫 DOM 的 `el.append()` 不會 ——
 * `el.append(showHint && h('p', ...))` 在 showHint 是 false 時，
 * 會在畫面上印出字串「false」。這個 bug 在中翻英模式實際出現過，
 * 而同樣的寫法散在五個模式裡，所以修在這裡一次解決。
 */
export function append(parent, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}
