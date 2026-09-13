// 語調曲線：從一段錄音的 PCM 抽出基頻（F0）。
//
// ─── 這份東西要回答什麼 ──────────────────────────────────────────────────
//
// Azure 的 prosody 只給一個分數（以及「這個字太平」這種標記），回答不了
// 「我的語調長什麼樣子」。而語調是少數**看得懂一張圖就馬上知道要改什麼**的東西：
// 句尾該降的地方你升上去了，一眼就看得出來，不需要任何術語。
//
// ─── 演算法：YIN 的簡化版 ────────────────────────────────────────────────
//
// 用 YIN（累積平均正規化的差分函數）而不是裸的自相關：自相關在低頻會被
// 「整數倍週期也很像」騙走，也就是八度錯誤 —— 症狀是曲線突然跳高或跳低 12 個半音，
// 看起來像使用者唸破音了。YIN 的第三步（累積平均正規化）就是在修這件事，
// 剩下的殘餘我們再用 `fixOctaveJumps()` 掃一遍。
//
// 不用 FFT／倒頻譜：那要自己實作 FFT，而這裡的資料量（3 秒、16 kHz）
// 直接算差分函數就夠快了（見下面的降取樣）。
//
// ─── 這份檔案是純函式，前後端共用 ────────────────────────────────────────
//
// 沒有 DOM、沒有 localStorage、沒有 Web Audio —— 吃 Float32Array 吐資料。
// **伺服器之後要算「範例句」的曲線時 import 同一份**（`lib/merge.js` 是同樣的先例）：
// 兩套程式算出來的兩條曲線會有系統性差異，而那種差異看起來就像「我唸得不像」。

/**
 * 人聲基頻的範圍。低於 60 Hz 是雜訊，高於 400 Hz 在朗讀句子時幾乎不會出現。
 *
 * **上限是時域偵測的本質限制，不只是個篩選條件**：超過 F_MAX 的純音會被算成
 * 它的次諧波（800 Hz 會抽出 267 Hz），因為那個週期也在搜尋範圍裡、而且完全吻合。
 * 朗讀的基頻不會到那裡，所以可以接受 —— 但別拿這份程式去分析唱歌或樂器。
 */
export const F_MIN = 60;
export const F_MAX = 400;

/** 分析窗與間隔。40 ms 至少裝得下 60 Hz 的兩個週期；10 ms 一格對語調來說綽綽有餘。 */
const FRAME_MS = 40;
const HOP_MS = 10;

/**
 * YIN 的判定門檻。越大越容易判成「有聲」，但也越容易把雜訊當成音高。
 *
 * 0.2 是拿 `test/fixtures/speech-16k.wav`（真人語音）試出來的：
 * 0.15 太保守（句子中間會斷成好幾截），0.4 開始把氣音也算進來。
 */
const THRESHOLD = 0.2;

/** 這一格的音量低於這個值就不用算了 —— 靜音算出來的音高是亂數。 */
const RMS_FLOOR = 0.006;

/** 分析用的取樣率。降到 8 kHz 之後計算量剩下約四分之一，而 400 Hz 以下完全夠用。 */
const ANALYSIS_RATE = 8000;

/**
 * 抽出一段錄音的語調曲線。
 *
 * @param {Float32Array|Array<number>} samples 單聲道 PCM（-1 ～ 1）
 * @param {number} sampleRate
 * @returns {{
 *   hopSec: number,
 *   points: Array<{t: number, hz: number, st: number}|null>,
 *   medianHz: number|null,
 *   voicedRatio: number,
 *   rangeSt: [number, number]|null,
 * }}
 *   `points` 每一格 10 ms，**無聲的格子是 `null` 而不是插值**：
 *   子音與停頓本來就沒有音高，補一條假的線上去等於在說謊。
 *   `st` 是相對於這段錄音自己的中位數的半音數 —— 比的是**形狀**，不是絕對音高
 *   （男聲低、TTS 高，比絕對值沒有意義）。
 */
export function pitchContour(samples, sampleRate) {
  const empty = { hopSec: HOP_MS / 1000, points: [], medianHz: null, voicedRatio: 0, rangeSt: null };
  if (!samples?.length || !(sampleRate > 0)) return empty;

  const { data, rate } = downsample(samples, sampleRate);
  const frame = Math.round((rate * FRAME_MS) / 1000);
  const hop = Math.round((rate * HOP_MS) / 1000);
  if (!(frame > 0) || !(hop > 0) || data.length < frame) return empty;

  const raw = [];
  for (let start = 0; start + frame <= data.length; start += hop) {
    raw.push(frameF0(data, start, frame, rate));
  }

  const hz = medianSmooth(fixOctaveJumps(raw));
  const voiced = hz.filter((f) => f !== null);
  if (voiced.length === 0) return { ...empty, points: hz.map(() => null) };

  const medianHz = median(voiced);
  const hopSec = HOP_MS / 1000;
  const points = hz.map((f, i) =>
    (f === null ? null : { t: i * hopSec, hz: f, st: semitones(f, medianHz) }));
  const sts = voiced.map((f) => semitones(f, medianHz));

  return {
    hopSec,
    points,
    medianHz,
    voicedRatio: voiced.length / hz.length,
    rangeSt: [Math.min(...sts), Math.max(...sts)],
  };
}

/** 兩個頻率差幾個半音。 */
export function semitones(hz, referenceHz) {
  return 12 * Math.log2(hz / referenceHz);
}

/**
 * 把曲線切成一段一段連續有聲的線。
 *
 * 畫圖的時候**不可以把無聲的格子連起來** —— 一條橫跨停頓的直線看起來像
 * 「你這裡拖了一個長音」，而事實是那裡根本沒有聲音。
 *
 * @param {Array<object|null>} points
 * @param {number} [minRun] 少於這麼多格的碎片直接丟掉（雜訊）
 * @returns {Array<Array<object>>}
 */
export function contourRuns(points, minRun = 3) {
  const runs = [];
  let run = [];
  for (const p of points ?? []) {
    if (p) {
      run.push(p);
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs.filter((r) => r.length >= minRun);
}

// ─── 內部（測得到，所以 export）──────────────────────────────────────────

/**
 * 降到 8 kHz 再算。
 *
 * 先做一次很輕的低通（[0.25, 0.5, 0.25]）再抽樣：直接抽樣會把高頻摺進來，
 * 而摺進來的能量正好會讓差分函數多出假的低點。
 * 已經在 8 kHz 以下就原樣回傳。
 */
export function downsample(samples, sampleRate) {
  const factor = Math.floor(sampleRate / ANALYSIS_RATE);
  if (factor < 2) return { data: samples, rate: sampleRate };

  const out = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i += 1) {
    const j = i * factor;
    const prev = samples[j - 1] ?? samples[j];
    const next = samples[j + 1] ?? samples[j];
    out[i] = 0.25 * prev + 0.5 * samples[j] + 0.25 * next;
  }
  return { data: out, rate: sampleRate / factor };
}

/**
 * 一格的基頻。判不出來（無聲、氣音、雜訊）回 null。
 *
 * YIN 的四個步驟：差分函數 → 累積平均正規化 → 取第一個低於門檻的局部極小 →
 * 拋物線內插。第三步取**第一個**而不是最小的那個，正是避免八度錯誤的關鍵：
 * 兩倍週期的地方通常也很低，但它不是第一個。
 */
export function frameF0(data, start, frame, rate) {
  let energy = 0;
  for (let i = 0; i < frame; i += 1) energy += data[start + i] ** 2;
  if (Math.sqrt(energy / frame) < RMS_FLOOR) return null;

  const tauMin = Math.max(2, Math.floor(rate / F_MAX));
  const tauMax = Math.min(Math.floor(rate / F_MIN), frame - 1);
  if (tauMax <= tauMin + 1) return null;

  const diff = new Float64Array(tauMax + 2);
  for (let tau = tauMin; tau <= tauMax + 1 && tau < frame; tau += 1) {
    let acc = 0;
    for (let i = 0; i + tau < frame; i += 1) {
      const d = data[start + i] - data[start + i + tau];
      acc += d * d;
    }
    diff[tau] = acc;
  }

  const norm = new Float64Array(tauMax + 2).fill(1);
  let running = 0;
  for (let tau = tauMin; tau <= tauMax + 1 && tau < frame; tau += 1) {
    running += diff[tau];
    norm[tau] = running === 0 ? 1 : (diff[tau] * (tau - tauMin + 1)) / running;
  }

  let best = -1;
  for (let tau = tauMin + 1; tau <= tauMax; tau += 1) {
    if (norm[tau] < THRESHOLD && norm[tau] <= norm[tau + 1]) { best = tau; break; }
  }
  if (best < 0) return null;

  // 拋物線內插：只用整數 tau 的話，解析度在高音處會粗到看得出階梯
  const a = norm[best - 1];
  const b = norm[best];
  const c = norm[best + 1];
  const denom = a - 2 * b + c;
  const shift = denom === 0 ? 0 : (a - c) / (2 * denom);
  const hz = rate / (best + shift);
  return hz >= F_MIN && hz <= F_MAX ? hz : null;
}

/**
 * 把殘餘的八度錯誤拉回來。
 *
 * YIN 已經擋掉大部分，但氣音與句尾的低音仍然會偶爾跳掉一個八度 ——
 * 那在圖上是一根 12 個半音的尖刺，而使用者會以為自己真的唱破了。
 *
 * 規則：跟左右鄰居（有聲的）的中位數差超過 7 個半音、而乘以 2 或除以 2 之後
 * 差距明顯變小，就當成八度錯誤修掉。**只修明確的那些** ——
 * 真正的語調起伏本來就可能有五、六個半音，修過頭會把真的曲線壓平。
 */
export function fixOctaveJumps(raw) {
  const out = raw.slice();
  for (let i = 0; i < out.length; i += 1) {
    const f = out[i];
    if (f === null) continue;
    const near = neighbours(out, i, 3);
    if (near.length < 2) continue;

    const ref = median(near);
    const base = Math.abs(semitones(f, ref));
    if (base <= 7) continue;
    for (const factor of [2, 0.5]) {
      const candidate = f * factor;
      if (candidate < F_MIN || candidate > F_MAX) continue;
      if (Math.abs(semitones(candidate, ref)) < base - 3) { out[i] = candidate; break; }
    }
  }
  return out;
}

/**
 * 寬度 3 的中位數濾波。單格的毛刺拿掉，真正的轉折留著（平均值會把轉折磨平）。
 *
 * **窗口湊不滿三個就原樣留著**（頭尾、以及停頓旁邊的那一格）：
 * 兩個值的中位數是它們的平均，那會把曲線的兩端往內拉一點點 ——
 * 而曲線的兩端正好是「句尾有沒有降下來」要看的地方。
 */
export function medianSmooth(values) {
  return values.map((v, i) => {
    if (v === null) return null;
    const window = [values[i - 1], v, values[i + 1]].filter((x) => typeof x === 'number');
    return window.length < 3 ? v : median(window);
  });
}

/** 左右各取幾格裡有聲的那些（不含自己）。 */
function neighbours(values, index, span) {
  const out = [];
  for (let i = index - span; i <= index + span; i += 1) {
    if (i !== index && typeof values[i] === 'number') out.push(values[i]);
  }
  return out;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
