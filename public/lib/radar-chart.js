// 四個能力面向的雷達圖（inline SVG）。
//
// 為什麼是 SVG 而不是 canvas：跟 `trend-chart.js` 同一個理由 ——
// 四個點的靜態圖不需要每秒重畫 60 次，而 SVG 可以直接縮放、
// 在深色模式下靠 CSS 變數換色，也不用處理 devicePixelRatio。
//
// ─── 沒有資料的那一軸不會被畫成 0 ────────────────────────────────────────
//
// `score` 是 null 的面向（樣本不夠，見 `ability.js`）**不進多邊形**：
// 把它當成 0 的話，沒練過聽力的人會看到一個往聽力方向凹進去的形狀，
// 而那個形狀在說「你的聽力很差」—— 它其實只是「還沒練過」。
// 那一軸畫成虛線，標籤寫「—」，而多邊形只連有資料的那幾個點。
//
// 代價是資料一多，形狀會從線變三角形再變四邊形（點數變了）。那是誠實的：
// 圖本來就只該畫它真的知道的事。

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 圖的座標系。實際顯示大小交給 CSS，這裡只是 viewBox 的單位。 */
const BOX = { size: 240, cx: 120, cy: 120, r: 78 };

/** 幾圈格線。25 / 50 / 75 / 100，跟「幾分」直接對得起來。 */
const RINGS = [25, 50, 75, 100];

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/**
 * 第 i 軸、分數 score 的座標。**從正上方開始順時針**，一軸 90 度。
 * 正上方開始是因為第一個面向（字彙）會落在那裡，而人讀圖是從上面開始讀的。
 */
function point(i, score, count, { cx, cy, r } = BOX) {
  const angle = (Math.PI * 2 * i) / count - Math.PI / 2;
  const d = (r * Math.min(100, Math.max(0, score))) / 100;
  return { x: cx + d * Math.cos(angle), y: cy + d * Math.sin(angle) };
}

/**
 * 畫出雷達圖。
 *
 * @param {Array<{id, label, score: number|null}>} dims `computeAbility()` 的結果
 * @returns {{svg: SVGElement, caption: string}}
 */
export function buildRadarChart(dims) {
  const list = Array.isArray(dims) ? dims : [];
  const n = list.length;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${BOX.size} ${BOX.size}`,
    class: 'radar__svg',
    role: 'img',
    'aria-labelledby': 'radar-caption',
  });
  if (n < 3) return { svg, caption: radarCaption(list) };

  // 格線：同心的多邊形，不是圓 —— 圓的話讀者會去比「離圓心多遠」，
  // 而軸與軸之間的區域其實沒有意義
  for (const ring of RINGS) {
    svg.append(svgEl('polygon', {
      class: ring === 100 ? 'radar__ring radar__ring--edge' : 'radar__ring',
      points: list.map((_, i) => {
        const p = point(i, ring, n);
        return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      }).join(' '),
    }));
  }

  // 每一軸的線與標籤
  list.forEach((dim, i) => {
    const end = point(i, 100, n);
    const has = typeof dim.score === 'number';
    svg.append(svgEl('line', {
      class: has ? 'radar__axis' : 'radar__axis radar__axis--empty',
      x1: BOX.cx, y1: BOX.cy, x2: end.x.toFixed(1), y2: end.y.toFixed(1),
    }));

    const at = point(i, 128, n);          // 標籤推到格線外面一點
    const label = svgEl('text', {
      class: 'radar__label',
      x: at.x.toFixed(1),
      y: at.y.toFixed(1),
      'text-anchor': anchorFor(at.x),
      'dominant-baseline': 'middle',
    });
    label.textContent = dim.label;
    svg.append(label);

    const value = svgEl('text', {
      class: has ? 'radar__value' : 'radar__value radar__value--empty',
      x: at.x.toFixed(1),
      y: (at.y + 13).toFixed(1),
      'text-anchor': anchorFor(at.x),
      'dominant-baseline': 'middle',
    });
    value.textContent = has ? String(dim.score) : '—';
    svg.append(value);
  });

  // 有資料的那幾個點。兩個以下連不成面，就只畫點
  const filled = list
    .map((dim, i) => (typeof dim.score === 'number' ? { dim, p: point(i, dim.score, n) } : null))
    .filter(Boolean);

  if (filled.length >= 3) {
    svg.append(svgEl('polygon', {
      class: 'radar__area',
      points: filled.map(({ p }) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
    }));
  } else if (filled.length === 2) {
    svg.append(svgEl('line', {
      class: 'radar__area radar__area--line',
      x1: filled[0].p.x.toFixed(1), y1: filled[0].p.y.toFixed(1),
      x2: filled[1].p.x.toFixed(1), y2: filled[1].p.y.toFixed(1),
    }));
  }

  for (const { dim, p } of filled) {
    const dot = svgEl('circle', { class: 'radar__dot', cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 3.5 });
    const title = svgEl('title');
    title.textContent = `${dim.label} ${dim.score} 分・${dim.detail ?? ''}`;
    dot.append(title);
    svg.append(dot);
  }

  return { svg, caption: radarCaption(list) };
}

/** 標籤在左半邊就靠右對齊，不然會蓋到圖。正上下方置中。 */
function anchorFor(x) {
  if (Math.abs(x - BOX.cx) < 1) return 'middle';
  return x > BOX.cx ? 'start' : 'end';
}

/**
 * 圖的文字說明。
 *
 * 圖對讀螢幕的人沒有意義，四個數字要用文字再講一次 ——
 * 跟 `trend-chart.js` 的 `trendCaption()` 同一個規矩。
 */
export function radarCaption(dims) {
  const list = Array.isArray(dims) ? dims : [];
  const scored = list.filter((d) => typeof d.score === 'number');
  if (scored.length === 0) return '四個能力面向都還沒有足夠的資料。練幾次就會出現。';

  const parts = list.map((d) =>
    typeof d.score === 'number' ? `${d.label} ${d.score} 分` : `${d.label}還沒有資料`);
  const lowest = scored.reduce((a, b) => (b.score < a.score ? b : a));
  return `四個能力面向：${parts.join('、')}。目前最低的是${lowest.label}。`;
}
