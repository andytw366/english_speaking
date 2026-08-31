// 分數趨勢圖（inline SVG）。
//
// 為什麼是 SVG 而不是 canvas：資料點最多 20 個，靜態圖不需要每秒重畫 60 次。
// SVG 可以直接縮放、在深色模式下靠 CSS 變數換色，也不用處理 devicePixelRatio。
// （錄音波形那邊才需要 canvas，見 waveform.js。）

import { formatTime, scoreClass } from './labels.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 圖的座標系。實際顯示大小交給 CSS，這裡只是 viewBox 的單位。 */
const BOX = { w: 320, h: 100, top: 8, right: 8, bottom: 16, left: 24 };

/** 格線的分數。60 / 80 跟紀錄清單上分數變色的門檻是同一組（labels.js 的 scoreClass）。 */
const GRID_SCORES = [0, 60, 80, 100];

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/**
 * 畫出趨勢圖。
 *
 * @param {Array<{at:string, score:number, sentenceText:string}>} points 由舊到新
 * @returns {{svg: SVGElement, caption: string}|null} 少於兩點時回 null（一個點連不成線）
 */
export function buildTrendChart(points) {
  if (!Array.isArray(points) || points.length < 2) return null;

  const { w, h, top, right, bottom, left } = BOX;
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  const x = (i) => left + (plotW * i) / (points.length - 1);
  const y = (score) => top + plotH * (1 - Math.min(100, Math.max(0, score)) / 100);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${w} ${h}`,
    class: 'trend__svg',
    role: 'img',
    'aria-labelledby': 'trend-caption',
  });

  for (const score of GRID_SCORES) {
    svg.append(
      svgEl('line', {
        class: score === 0 || score === 100 ? 'trend__grid' : 'trend__grid trend__grid--dashed',
        x1: left,
        x2: w - right,
        y1: y(score),
        y2: y(score),
      })
    );
    const label = svgEl('text', { class: 'trend__label', x: left - 4, y: y(score) + 3 });
    label.textContent = String(score);
    svg.append(label);
  }

  svg.append(
    svgEl('polyline', {
      class: 'trend__line',
      points: points.map((p, i) => `${x(i)},${y(p.score)}`).join(' '),
    })
  );

  points.forEach((point, i) => {
    const dot = svgEl('circle', {
      class: `trend__dot trend__dot--${scoreClass(point.score).replace('score--', '')}`,
      cx: x(i),
      cy: y(point.score),
      r: 3.5,
    });
    // 滑鼠移上去看得到是哪一句、什麼時候練的
    const title = svgEl('title');
    title.textContent = `${formatTime(point.at)}・${point.score} 分・${point.sentenceText}`;
    dot.append(title);
    svg.append(dot);
  });

  return { svg, caption: trendCaption(points) };
}

/** 圖的文字說明。圖本身對讀螢幕的人沒有意義，走勢要用文字再講一次。 */
function trendCaption(points) {
  const first = points[0];
  const last = points.at(-1);
  const delta = last.score - first.score;
  const direction = delta > 0 ? `進步 ${delta} 分` : delta < 0 ? `退步 ${-delta} 分` : '持平';
  return (
    `最近 ${points.length} 次的分數走勢（左舊右新）：` +
    `${formatTime(first.at)} ${first.score} 分 → ${formatTime(last.at)} ${last.score} 分，${direction}。`
  );
}
