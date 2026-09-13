// 語調曲線（F0 抽取）的回歸測試。不需要瀏覽器、網路或金鑰。
//
// 這裡在意的是三件事，而它們壞掉的樣子都不會有錯誤訊息：
//   1. **算出來的數字要對** —— 合成音的頻率是已知的，偏掉就是演算法壞了
//   2. **無聲不可以有音高** —— 補一條假的線上去等於在圖上說謊
//   3. **不可以有八度尖刺** —— 圖上一根 12 個半音的刺，使用者會以為自己唱破了
//
// 真人語音用 repo 裡現成的 `test/fixtures/speech-16k.wav`（16 kHz 單聲道，
// 跟 App 的錄音管線同格式）—— 合成訊號測得了準確度，測不了「真的聲音長怎樣」。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  pitchContour, contourRuns, semitones, downsample, fixOctaveJumps, medianSmooth,
  compactContour, expandContour, F_MIN, F_MAX,
} from '../public/lib/pitch.js';

const RATE = 16000;

/** 固定頻率的正弦波。振幅刻意不是 1 —— 真實錄音不會頂到滿格。 */
function tone(hz, seconds, rate = RATE, amplitude = 0.3) {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  }
  return out;
}

/** 從 from 掃到 to 的正弦波（相位連續，不然接縫會被當成新的週期）。 */
function sweep(from, to, seconds, rate = RATE) {
  const out = new Float32Array(Math.round(rate * seconds));
  let phase = 0;
  for (let i = 0; i < out.length; i += 1) {
    const hz = from + ((to - from) * i) / out.length;
    phase += (2 * Math.PI * hz) / rate;
    out[i] = 0.3 * Math.sin(phase);
  }
  return out;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** 讀 16-bit 單聲道 WAV。測試自己解，免得為了一個 fixture 多一個相依。 */
function readWav(file) {
  const buf = fs.readFileSync(file);
  const sampleRate = buf.readUInt32LE(24);
  let off = 12;
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = Math.floor(size / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i += 1) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return { sampleRate, samples: out };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`${file} 裡找不到 data chunk`);
}

// ─── 準確度 ──────────────────────────────────────────────────────────────

test('固定頻率的音抽出來就是那個頻率', () => {
  for (const hz of [90, 150, 220, 330]) {
    const { medianHz, voicedRatio } = pitchContour(tone(hz, 0.6), RATE);
    assert.ok(Math.abs(medianHz - hz) < 2, `${hz} Hz → ${medianHz?.toFixed(1)}`);
    assert.ok(voicedRatio > 0.9, `${hz} Hz 的有聲比例 ${voicedRatio}`);
  }
});

test('降到 8 kHz 分析不會讓頻率跑掉', () => {
  // 降取樣是為了快四倍。準確度掉了的話這個交換就不划算了
  const { data, rate } = downsample(tone(200, 0.5), RATE);
  assert.equal(rate, 8000);
  assert.equal(data.length, RATE * 0.5 / 2);

  const at16k = pitchContour(tone(200, 0.5), RATE).medianHz;
  const at8k = pitchContour(tone(200, 0.5, 8000), 8000).medianHz;
  assert.ok(Math.abs(at16k - at8k) < 2, `${at16k} vs ${at8k}`);
});

test('上揚的音抽出來就是上揚的曲線', () => {
  // 200 → 300 Hz 是 +7 個半音（3:2 剛好是純五度）
  const { points, rangeSt } = pitchContour(sweep(200, 300, 1), RATE);
  const voiced = points.filter(Boolean);

  assert.ok(voiced[0].hz < voiced[voiced.length - 1].hz);
  assert.ok(rangeSt[1] - rangeSt[0] > 5.5 && rangeSt[1] - rangeSt[0] < 8.5,
    `半音範圍 ${(rangeSt[1] - rangeSt[0]).toFixed(1)}`);

  // 單調上升：容許中位數濾波造成的持平，但不可以往回掉
  for (let i = 1; i < voiced.length; i += 1) {
    assert.ok(voiced[i].hz >= voiced[i - 1].hz - 1.5,
      `第 ${i} 格往回掉了 ${voiced[i - 1].hz} → ${voiced[i].hz}`);
  }
});

test('半音是相對於這段自己的中位數 —— 比的是形狀不是絕對音高', () => {
  // 同一條曲線移高一個八度，形狀（半音）要一模一樣
  const low = pitchContour(sweep(100, 150, 1), RATE);
  const high = pitchContour(sweep(200, 300, 1), RATE);
  assert.ok(Math.abs(low.rangeSt[0] - high.rangeSt[0]) < 0.6,
    `${low.rangeSt} vs ${high.rangeSt}`);
  assert.ok(Math.abs(low.rangeSt[1] - high.rangeSt[1]) < 0.6);
});

// ─── 無聲 ────────────────────────────────────────────────────────────────

test('靜音沒有音高，而且不會丟例外', () => {
  const silence = new Float32Array(RATE);
  const contour = pitchContour(silence, RATE);
  assert.equal(contour.medianHz, null);
  assert.equal(contour.voicedRatio, 0);
  assert.ok(contour.points.every((p) => p === null));
});

test('停頓的那幾格是 null，不是插值', () => {
  // 有聲 → 靜音 → 有聲。中間那段如果被連起來，圖上會多一條假的長音
  const contour = pitchContour(
    concat(tone(200, 0.4), new Float32Array(RATE * 0.3), tone(200, 0.4)), RATE);
  const gap = contour.points.filter((p) => p === null);
  assert.ok(gap.length > 15, `中間只有 ${gap.length} 格無聲`);
  assert.ok(contour.voicedRatio > 0.5 && contour.voicedRatio < 0.9,
    `有聲比例 ${contour.voicedRatio}`);
});

test('壞掉的輸入回空的曲線，不會炸', () => {
  for (const input of [null, undefined, new Float32Array(0), [1, 2, 3]]) {
    const contour = pitchContour(input, RATE);
    assert.equal(contour.medianHz, null);
    assert.deepEqual(contour.points, []);
  }
  assert.equal(pitchContour(tone(200, 0.5), 0).medianHz, null);
});

test('低於人聲範圍的頻率不會被當成音高', () => {
  // 40 / 55 Hz 是冷氣與電源的嗡嗡聲那一帶，不是朗讀時的基頻
  assert.equal(pitchContour(tone(40, 0.5), RATE).medianHz, null);
  assert.equal(pitchContour(tone(55, 0.5), RATE).medianHz, null);
  assert.ok(F_MIN < 80 && F_MAX > 300);
});

test('高於人聲範圍的純音會被算成次諧波 —— 這是本質限制，記在這裡', () => {
  // 800 Hz 的週期不在搜尋範圍裡，但它的三倍週期（267 Hz）完全吻合，
  // 所以時域偵測一定會抽到那個。朗讀的基頻不會到 400 Hz 以上，所以可以接受；
  // 但這條測試是要讓下一個人知道**這不是 bug，是這個演算法的邊界**
  const { medianHz } = pitchContour(tone(800, 0.5), RATE);
  assert.ok(medianHz !== null && medianHz < F_MAX, `${medianHz}`);
});

// ─── 八度尖刺 ────────────────────────────────────────────────────────────

test('fixOctaveJumps：孤立的八度跳被拉回來', () => {
  // 圖上一根 12 個半音的刺，使用者會以為自己唱破了
  const raw = [200, 202, 198, 400, 201, 199, 203];
  assert.deepEqual(fixOctaveJumps(raw).map(Math.round), [200, 202, 198, 200, 201, 199, 203]);

  const low = [200, 202, 198, 100, 201, 199, 203];
  assert.deepEqual(fixOctaveJumps(low).map(Math.round), [200, 202, 198, 200, 201, 199, 203]);
});

test('fixOctaveJumps：真正的語調起伏不會被壓平', () => {
  // 五、六個半音的起伏是正常的語調，修過頭會把真的曲線磨掉
  const rise = [200, 210, 225, 240, 260, 275];
  assert.deepEqual(fixOctaveJumps(rise), rise);
});

test('fixOctaveJumps：無聲的格子照樣是無聲', () => {
  const raw = [200, null, 400, null, 202];
  const fixed = fixOctaveJumps(raw);
  assert.equal(fixed[1], null);
  assert.equal(fixed[3], null);
});

test('medianSmooth：拿掉單格毛刺，保留轉折', () => {
  assert.deepEqual(medianSmooth([100, 100, 180, 100, 100]), [100, 100, 100, 100, 100]);
  // 真的轉折（一路往上）不可以被磨平
  assert.deepEqual(medianSmooth([100, 110, 120, 130]), [100, 110, 120, 130]);
  assert.deepEqual(medianSmooth([null, 100, null]), [null, 100, null]);
});

test('medianSmooth：頭尾不因為窗口湊不滿而被往內拉', () => {
  // 兩個值的中位數是平均值，會把句首句尾的高度改掉 ——
  // 而句尾降不降下來正是這張圖最重要的那一段
  assert.deepEqual(medianSmooth([100, 200, 200, 300]), [100, 200, 200, 300]);
  assert.deepEqual(medianSmooth([100, null, 300]), [100, null, 300]);
});

// ─── 畫圖用的切段 ────────────────────────────────────────────────────────

test('contourRuns：連續有聲的切成一段，停頓把它們分開', () => {
  const p = (hz) => ({ t: 0, hz, st: 0 });
  const runs = contourRuns([p(1), p(2), p(3), null, null, p(4), p(5), p(6), p(7)]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => r.length), [3, 4]);
});

test('contourRuns：太短的碎片丟掉（那是雜訊不是語調）', () => {
  const p = (hz) => ({ t: 0, hz, st: 0 });
  const runs = contourRuns([p(1), null, p(2), p(3), p(4), p(5)]);
  assert.deepEqual(runs.map((r) => r.length), [4]);
  assert.deepEqual(contourRuns([]), []);
  assert.deepEqual(contourRuns(null), []);
});

// ─── 真人語音 ────────────────────────────────────────────────────────────

test('真人錄音抽得出像樣的曲線', () => {
  const file = path.join(import.meta.dirname, 'fixtures', 'speech-16k.wav');
  const { sampleRate, samples } = readWav(file);
  const contour = pitchContour(samples, sampleRate);

  // 這個 fixture 是一段 1.5 秒的真人英語（audio.test.js 也用它當正向樣本）
  assert.ok(contour.medianHz > 80 && contour.medianHz < 350,
    `中位數 ${contour.medianHz?.toFixed(1)} Hz`);
  // 前後有靜音、中間有子音，所以有聲比例本來就不會太高；但也不能一格都沒有
  assert.ok(contour.voicedRatio > 0.15 && contour.voicedRatio < 0.8,
    `有聲比例 ${contour.voicedRatio.toFixed(2)}`);
  // 真人講話一定有起伏 —— 全平代表演算法把所有格子都判成同一個值
  const span = contour.rangeSt[1] - contour.rangeSt[0];
  assert.ok(span > 2 && span < 24, `半音範圍 ${span.toFixed(1)}`);
  // 而且畫得出至少兩段（中間有停頓）
  assert.ok(contourRuns(contour.points).length >= 2);
});

// ─── 存得下的形狀（範例句的曲線要存在伺服器上）──────────────────────────

test('compactContour：只留半音、小數一位', () => {
  const contour = pitchContour(sweep(200, 300, 0.6), RATE);
  const compact = compactContour(contour);

  assert.equal(compact.hopSec, contour.hopSec);
  assert.equal(compact.points.length, contour.points.length);
  for (const st of compact.points) {
    if (st === null) continue;
    assert.equal(Math.round(st * 10) / 10, st, `${st} 不是一位小數`);
  }
});

test('compact → expand 回得來，形狀一樣', () => {
  const contour = pitchContour(sweep(180, 260, 0.8), RATE);
  const back = expandContour(compactContour(contour));

  assert.equal(back.points.length, contour.points.length);
  // 半音差在四捨五入的誤差內（0.05），時間對得上
  contour.points.forEach((p, i) => {
    if (!p) return assert.equal(back.points[i], null);
    assert.ok(Math.abs(back.points[i].st - p.st) <= 0.05, `第 ${i} 格 ${back.points[i].st} vs ${p.st}`);
    assert.ok(Math.abs(back.points[i].t - p.t) < 1e-9);
  });
  assert.ok(Math.abs(back.rangeSt[0] - contour.rangeSt[0]) <= 0.05);
});

test('expandContour：壞掉的輸入不會炸', () => {
  for (const input of [null, undefined, {}, { points: 'x' }]) {
    const back = expandContour(input);
    assert.deepEqual(back.points, []);
    assert.equal(back.rangeSt, null);
  }
});

test('壓完的大小是可以存的量級', () => {
  // 一句三秒的曲線大約 1.5 KB。會長到十倍的話就得改成降取樣再存
  const compact = compactContour(pitchContour(sweep(180, 260, 3), RATE));
  const bytes = JSON.stringify(compact).length;
  assert.ok(bytes < 4000, `${bytes} bytes`);
});

test('semitones：12 個半音是一個八度', () => {
  assert.equal(Math.round(semitones(400, 200)), 12);
  assert.equal(Math.round(semitones(100, 200)), -12);
  assert.equal(semitones(200, 200), 0);
});
