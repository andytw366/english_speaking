// server/audio.js 的回歸測試。
//
// 這支測試的存在理由：無人聲偵測完全靠 server/audio.js 的三個門檻值，
// 而門檻調得太嚴就會誤擋真人的小聲錄音（比原本的 bug 更糟）。
// 所以這裡同時測兩個方向 —— 該擋的要擋、真實語音不管音量都不可以擋。
//
// fixtures/speech-16k.wav 是真實的英語語音（"Hello, how are you today?"），
// 用 Gemini TTS 產生後重取樣成專案實際使用的 16 kHz 單聲道 16-bit WAV。
// 不用合成訊號當正向樣本，是因為合成訊號的能量分布跟真人說話差很多，測不出誤擋。
//
// 執行：npm test（不需要網路，也不需要 API 金鑰）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyseWavPcm16, isSilentRecording } from '../server/audio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEECH_WAV = fs.readFileSync(path.join(HERE, 'fixtures', 'speech-16k.wav'));

const SAMPLE_RATE = 16000;

function encodeWav(samples, rate = SAMPLE_RATE) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** 讀出 fixture 的 PCM，乘上 gain 後重新編碼，用來模擬不同的錄音音量。 */
function speechAtVolume(gain) {
  const count = (SPEECH_WAV.length - 44) / 2;
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = (SPEECH_WAV.readInt16LE(44 + i * 2) / 32768) * gain;
  }
  return encodeWav(samples);
}

const generate = (seconds, fn) =>
  encodeWav(Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, i) => fn(i)));

// ─── 不可以擋下的：真實語音 ──────────────────────────────────────────────

test('真實語音在各種音量下都不會被當成無人聲', () => {
  // 0.05 = 錄音音量只有原本的 5%（峰值約 0.044，很小聲但還聽得到）
  for (const gain of [1, 0.5, 0.3, 0.1, 0.05]) {
    const stats = analyseWavPcm16(speechAtVolume(gain));
    assert.equal(stats.analysed, true, `gain=${gain} 應該要分析得出來`);
    assert.equal(
      isSilentRecording(stats),
      false,
      `gain=${gain} 的真實語音被誤判成無人聲（peak=${stats.peak.toFixed(4)}、` +
        `voicedRatio=${stats.voicedRatio.toFixed(3)}、flatness=${stats.flatness.toFixed(3)}）`
    );
  }
});

test('真實語音的能量起伏遠高於平穩噪音', () => {
  const speech = analyseWavPcm16(speechAtVolume(1));
  const hum = analyseWavPcm16(generate(1, (i) => Math.sin(i / 7) * 0.3));
  // 實測語音約 1.19、穩定正弦波約 0.008，中間有兩個數量級的差距
  assert.ok(
    speech.flatness > hum.flatness * 10,
    `語音 flatness=${speech.flatness.toFixed(3)} 應該遠大於嗡嗡聲 ${hum.flatness.toFixed(3)}`
  );
});

// ─── 必須擋下的：沒有人聲 ────────────────────────────────────────────────

test('純數位靜音會被擋下', () => {
  assert.equal(isSilentRecording(analyseWavPcm16(generate(1, () => 0))), true);
});

test('極低的環境噪音會被擋下', () => {
  // 峰值 0.008，遠低於 PEAK_FLOOR
  const stats = analyseWavPcm16(generate(1, () => (Math.random() * 2 - 1) * 0.008));
  assert.equal(isSilentRecording(stats), true);
});

test('音量夠大但完全平穩的嗡嗡聲會被擋下', () => {
  // 這是 PEAK_FLOOR 擋不住的情況 —— 峰值 0.3 很大聲，但從頭到尾一動也不動，
  // 不可能是人在說話。靠的是 flatness 這關。
  const stats = analyseWavPcm16(generate(1, (i) => Math.sin(i / 7) * 0.3));
  assert.ok(stats.peak > 0.2, '這個案例的音量本來就該很大');
  assert.equal(isSilentRecording(stats), true);
});

// ─── 解析本身的行為 ──────────────────────────────────────────────────────

test('無法解析的輸入一律放行，不做判斷', () => {
  // 寧可漏擋也不要誤擋：認不得的格式就交給後面的流程處理。
  for (const bad of [Buffer.alloc(0), Buffer.from('not a wav file at all'), null]) {
    const stats = analyseWavPcm16(bad);
    assert.equal(stats.analysed, false);
    assert.equal(isSilentRecording(stats), false);
  }
});

test('非 PCM16 的 WAV 會被標成無法分析', () => {
  const wav = generate(1, () => 0.5);
  wav.writeUInt16LE(3, 20); // audioFormat 改成 3（IEEE float）
  assert.equal(analyseWavPcm16(wav).analysed, false);
});

test('回報的長度與取樣率相符', () => {
  const stats = analyseWavPcm16(generate(2, (i) => Math.sin(i / 20) * 0.5));
  assert.ok(Math.abs(stats.durationSec - 2) < 0.01, `durationSec=${stats.durationSec}`);
});
