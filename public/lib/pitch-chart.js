// 語調圖（inline SVG）。跟趨勢圖同一個做法與理由（見 trend-chart.js）：
// 資料是靜態的，SVG 縮放不失真、深色模式靠 CSS 變數換色，也不必管 devicePixelRatio。
//
// ─── 這張圖刻意不做的事 ──────────────────────────────────────────────────
//
// **不算分數。** Azure 已經給 prosody 分數了，這裡再算一個「語調分」，
// 兩個數字遲早會對不起來，而使用者不知道該信哪一個。這張圖是拿來**看**的。
//
// **不把無聲的地方連起來。** 子音與停頓本來就沒有音高，連一條線上去
// 看起來像「你這裡拖了一個長音」—— 那是圖在說謊。切段的規則在 pitch.js 的
// `contourRuns()`。
//
// **y 軸是半音、以自己的中位數為 0。** 男聲低、女聲高，比絕對音高沒有意義；
// 要比的是形狀（哪裡升、哪裡降、起伏多大）。

import { contourRuns } from './pitch.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 座標系。實際大小交給 CSS，這裡只是 viewBox 的單位。 */
const BOX = { w: 320, h: 110, top: 10, right: 8, bottom: 22, left: 22 };

/** y 軸至少涵蓋正負這麼多半音。起伏小的句子不該被放大成劇烈波動。 */
const MIN_SPAN_ST = 4;

/** 畫得出圖的最低要求：有聲的格子太少就只是幾個點，看不出語調。 */
const MIN_VOICED = 8;

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/**
 * 畫出語調圖。
 *
 * @param {object} contour `pitchContour()` 的結果
 * @param {object} [options]
 * @param {Array<{word:string, start:number|null, duration:number|null, errorType:string}>}
 *   [options.words] Azure 的逐字時間。沒有就只畫曲線（Gemini 那條路沒有逐字資料）
 * @param {string} [options.titleId] 給 aria-labelledby 用
 * @returns {{svg: SVGElement, caption: string}|null} 資料不夠時回 null
 */
export function buildPitchChart(contour, { words = [], titleId = '' } = {}) {
  const runs = contourRuns(contour?.points ?? []);
  const voiced = runs.reduce((n, r) => n + r.length, 0);
  if (voiced < MIN_VOICED) return null;

  const { w, h, top, right, bottom, left } = BOX;
  const plotW = w - left - right;
  const plotH = h - top - bottom;

  // x 軸的範圍用整段錄音的長度，不是「有聲的那幾段」——
  // 開頭的停頓也是語調的一部分（而且切掉之後字的位置就對不上了）
  const endSec = Math.max(
    (contour.points.length - 1) * contour.hopSec,
    ...words.map((word) => (word.start ?? 0) + (word.duration ?? 0)),
  );
  // 曲線畫得出來就一定有 rangeSt，但這裡是公開 API —— 手餵資料進來的人不必知道
  const range = contour.rangeSt ?? [0, 0];
  const span = Math.max(MIN_SPAN_ST, ...range.map((v) => Math.abs(v) + 0.5));
  const x = (t) => left + (endSec > 0 ? (plotW * t) / endSec : 0);
  const y = (st) => top + plotH * (0.5 - st / (2 * span));

  const svg = svgEl('svg', {
    viewBox: `0 0 ${w} ${h}`,
    class: 'pitch__svg',
    role: 'img',
    ...(titleId ? { 'aria-labelledby': titleId } : {}),
  });

  // 中線＝這段錄音自己的平均高度。上下兩條虛線是 ±span/2，給起伏一個比例尺
  for (const st of [span / 2, 0, -span / 2]) {
    svg.append(svgEl('line', {
      class: st === 0 ? 'pitch__grid pitch__grid--mid' : 'pitch__grid',
      x1: left, x2: w - right, y1: y(st), y2: y(st),
    }));
  }
  const scale = svgEl('text', { class: 'pitch__axis', x: left - 4, y: y(span / 2) + 3 });
  scale.textContent = `+${Math.round(span / 2)}`;
  svg.append(scale);

  // 字的分隔線與標籤。只標得下的才標 —— 一句十個字全部塞進 320 單位會疊在一起
  for (const word of wordsToLabel(words, endSec, plotW)) {
    svg.append(svgEl('line', {
      class: 'pitch__word-line',
      x1: x(word.start), x2: x(word.start), y1: top, y2: h - bottom,
    }));
    const label = svgEl('text', {
      class: 'pitch__word' + (isProsodyIssue(word) ? ' pitch__word--flag' : ''),
      x: x(word.start + word.duration / 2),
      y: h - 6,
    });
    label.textContent = word.word;
    svg.append(label);
  }

  for (const run of runs) {
    svg.append(svgEl('polyline', {
      class: 'pitch__line',
      points: run.map((p) => `${x(p.t).toFixed(1)},${y(p.st).toFixed(1)}`).join(' '),
    }));
  }

  return { svg, caption: caption(contour, words) };
}

/**
 * 圖下面那句話。**這是圖的替代文字**，看不到圖（螢幕閱讀器、圖沒載出來）的人
 * 要靠它知道發生了什麼事，所以它得自己講得完整。
 */
export function caption(contour, words = []) {
  const span = contour.rangeSt ? contour.rangeSt[1] - contour.rangeSt[0] : 0;
  const shape = span < 3 ? '整句幾乎是平的'
    : span < 7 ? '有起伏但不大'
      : '起伏明顯';
  const flagged = words.filter(isProsodyIssue).map((word) => word.word);
  const tail = flagged.length
    ? `　Azure 點名的字：${flagged.slice(0, 3).join('、')}`
    : '';
  return `你的語調：${shape}（高低差約 ${Math.round(span)} 個半音）。${tail}`;
}

/** Azure 標成語調有問題的字（太平、不該停的地方停了、該停沒停）。 */
function isProsodyIssue(word) {
  return ['Monotone', 'UnexpectedBreak', 'MissingBreak'].includes(word?.errorType);
}

/**
 * 挑得出位置、而且標得下的字。
 *
 * 標不下就不標：字疊在一起的圖比沒有字的圖更難看懂。優先留 Azure 點名的字 ——
 * 那些正是使用者要看的地方。
 */
function wordsToLabel(words, endSec, plotW) {
  const usable = (words ?? []).filter(
    (word) => typeof word.start === 'number' && typeof word.duration === 'number' && word.word
  );
  if (!usable.length || !(endSec > 0)) return [];

  // 一個字大概要 26 個單位才放得下（CSS 裡是 7px 的字）
  const room = Math.max(1, Math.floor(plotW / 26));
  if (usable.length <= room) return usable;

  const flagged = usable.filter(isProsodyIssue);
  const rest = usable.filter((word) => !isProsodyIssue(word));
  const step = Math.ceil(usable.length / Math.max(1, room - flagged.length));
  const sampled = rest.filter((_, i) => i % step === 0);
  return [...flagged, ...sampled]
    .slice(0, room)
    .sort((a, b) => a.start - b.start);
}
