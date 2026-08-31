// 階段 5：錄音時的即時波形。
//
// 用 AnalyserNode 取時域資料，用 requestAnimationFrame 畫到 canvas 上。
// 除了好看之外還有實際用途 —— 使用者當下就看得出麥克風到底有沒有收到聲音，
// 不用等送出後才被「沒有偵測到人聲」擋下來。

const FFT_SIZE = 2048;
/** 波形往前捲動的取樣點數，決定畫面上顯示多長的歷史。 */
const HISTORY_POINTS = 240;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {(level: number) => void} [onLevel] 每一幀回報目前音量（0~1）
 */
export function createWaveform(canvas, onLevel) {
  const ctx = canvas.getContext('2d');
  let audioCtx = null;
  let analyser = null;
  let source = null;
  let rafId = null;
  let buffer = null;
  // 每個點存 [最小值, 最大值]，這樣捲動的波形才看得出振幅包絡
  let history = [];

  /** canvas 的 CSS 尺寸會被 devicePixelRatio 放大，不處理的話在高解析螢幕上會糊掉。 */
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { w, h };
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function draw() {
    const { w, h } = resize();
    const mid = h / 2;

    ctx.clearRect(0, 0, w, h);

    // 中線
    ctx.strokeStyle = cssVar('--border', '#e3e6ea');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    if (history.length === 0) return;

    const barWidth = w / HISTORY_POINTS;
    ctx.fillStyle = cssVar('--accent', '#2f6feb');
    history.forEach(([min, max], i) => {
      const x = i * barWidth;
      // 至少 1px 高，否則安靜的片段會整段消失、看起來像當掉
      const top = mid - max * mid;
      const height = Math.max(1, (max - min) * mid);
      ctx.fillRect(x, top, Math.max(1, barWidth - 1), height);
    });
  }

  function tick() {
    analyser.getFloatTimeDomainData(buffer);

    let min = 0;
    let max = 0;
    let peak = 0;
    for (let i = 0; i < buffer.length; i++) {
      const v = buffer[i];
      if (v < min) min = v;
      if (v > max) max = v;
      const abs = Math.abs(v);
      if (abs > peak) peak = abs;
    }

    history.push([min, max]);
    if (history.length > HISTORY_POINTS) history.shift();

    onLevel?.(peak);
    draw();
    rafId = requestAnimationFrame(tick);
  }

  return {
    /** @param {MediaStream} stream 錄音用的同一條 stream */
    start(stream) {
      this.stop();
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return false; // 不支援就安靜地不畫，錄音本身不受影響

      try {
        audioCtx = new AudioCtx();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        // 時域資料不需要平滑，平滑只會讓波形變遲鈍
        analyser.smoothingTimeConstant = 0;
        buffer = new Float32Array(analyser.fftSize);
        source = audioCtx.createMediaStreamSource(stream);
        // 只接到 analyser，不接 destination —— 接了會從喇叭放出來造成回授
        source.connect(analyser);
      } catch (err) {
        console.warn('[waveform] 無法建立音訊分析，略過波形顯示：', err);
        this.stop();
        return false;
      }

      history = [];
      canvas.hidden = false;
      rafId = requestAnimationFrame(tick);
      return true;
    },

    /** 停止並釋放資源。重複呼叫是安全的。 */
    stop() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      // AudioContext 不關掉的話，每次錄音都會留一個 —— 瀏覽器對同時存在的
      // AudioContext 數量有上限，累積到上限後就再也建不出新的了。
      try {
        source?.disconnect();
        analyser?.disconnect();
        audioCtx?.close();
      } catch {
        /* 已經關掉了就算了 */
      }
      source = null;
      analyser = null;
      audioCtx = null;
      buffer = null;
      onLevel?.(0);
    },

    /** 停止後把畫面清掉並收起來。 */
    reset() {
      this.stop();
      history = [];
      canvas.hidden = true;
      const { w, h } = resize();
      ctx.clearRect(0, 0, w, h);
    },
  };
}
