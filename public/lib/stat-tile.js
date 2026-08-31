// 統計磚（一個大數字 + 一行說明）。
//
// 練習紀錄卡片與一組練完的總結都用它 —— 同一種東西在兩張卡片上長得不一樣的話，
// 使用者會以為那是兩種不同的資訊。

/**
 * @param {string} label 下方的說明文字
 * @param {string} value 上方的數字（已經格式化好的字串）
 * @returns {HTMLElement}
 */
export function statTile(label, value) {
  const tile = document.createElement('div');
  tile.className = 'stat';

  const v = document.createElement('span');
  v.className = 'stat__value';
  v.textContent = value;

  const l = document.createElement('span');
  l.className = 'stat__label';
  l.textContent = label;

  tile.append(v, l);
  return tile;
}
