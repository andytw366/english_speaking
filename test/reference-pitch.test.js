// 「範例句」的語調曲線：對齊規則、快取判斷、以及合成出來的東西怎麼變成一份文件。
//
// **不呼叫 Azure**：合成器是注入的（假的），音訊是自己合出來的正弦波。
// 真的要花錢的那一段（speakTextAsync）在這裡不跑 —— 這裡驗的是它前後的所有規則。

import test from 'node:test';
import assert from 'node:assert/strict';

// reason 的值從 SDK 拿，不要在測試裡寫死一個數字 —— 寫死的話 SDK 改了它，
// 測試會繼續綠燈，而真的跑起來每一次合成都被當成失敗
import { ResultReason } from 'microsoft-cognitiveservices-speech-sdk';

import { buildDoc, isUsable, getReferencePitch } from '../server/reference-pitch.js';
import { alignReference } from '../public/lib/pitch-chart.js';

const RATE = 16000;

/** 造一段 16-bit 單聲道 WAV（跟 Azure 回的格式一樣）。 */
function wav(hz, seconds, rate = RATE) {
  const frames = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + frames * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // 單聲道
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    buf.writeInt16LE(Math.round(0.3 * Math.sin((2 * Math.PI * hz * i) / rate) * 32767), 44 + i * 2);
  }
  return buf;
}

// ─── 合成出來的東西 → 一份存得下的文件 ──────────────────────────────────

test('buildDoc：抽得出曲線，也留得住逐字時間', () => {
  const doc = buildDoc({
    id: 7,
    text: 'hello there',
    voice: 'test-voice',
    audio: wav(200, 1),
    words: [
      { word: 'hello', start: 0.1, duration: 0.4 },
      { word: 'there', start: 0.55, duration: 0.35 },
    ],
    now: Date.UTC(2026, 0, 1),
  });

  assert.equal(doc.id, 7);
  assert.equal(doc.voice, 'test-voice');
  assert.ok(Math.abs(doc.medianHz - 200) < 2, `${doc.medianHz}`);
  assert.ok(doc.points.length > 50);
  assert.deepEqual(doc.words.map((w) => w.word), ['hello', 'there']);
  assert.equal(doc.durationSec, 1);
  assert.equal(doc.at, '2026-01-01T00:00:00.000Z');
});

test('buildDoc：抽不出音高就回 null，不要存一份畫不出來的曲線', () => {
  // 存了的話每次都拿到一張空圖，而且因為「有快取」就再也不會重試
  const silence = wav(200, 1);
  silence.fill(0, 44);
  assert.equal(buildDoc({ id: 1, text: 'x', voice: 'v', audio: silence }), null);
});

test('buildDoc：解不開的音訊回 null，不丟例外', () => {
  assert.equal(buildDoc({ id: 1, text: 'x', voice: 'v', audio: Buffer.alloc(10) }), null);
});

test('isUsable：認不得的快取當成沒有快取', () => {
  assert.equal(isUsable({ hopSec: 0.01, points: [1, null, 2] }), true);
  assert.equal(isUsable({ hopSec: 0.01, points: [null, null] }), false);  // 全是無聲
  assert.equal(isUsable({ hopSec: 0.01, points: [] }), false);
  assert.equal(isUsable({ points: [1, 2] }), false);                      // 沒有 hopSec
  assert.equal(isUsable(null), false);
  assert.equal(isUsable({ contour: 'x' }), false);                        // 舊格式
});

// ─── 快取、額度、失敗 ────────────────────────────────────────────────────

/** 假的 store：記在記憶體裡。 */
function fakeStore(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    writes: 0,
    async readPitch(voice, id) { return files.get(`${voice}/${id}`) ?? null; },
    async writePitch(voice, id, doc) { this.writes += 1; files.set(`${voice}/${id}`, doc); },
  };
}

/** 假的合成器：不碰網路，回一段固定頻率的音。 */
function fakeSynth(calls = []) {
  return () => ({
    set wordBoundary(fn) {
      // SDK 是「設一個 callback 欄位」的形狀，這裡照樣模擬
      this._boundary = fn;
    },
    get wordBoundary() { return this._boundary; },
    speakTextAsync(text, onDone) {
      calls.push(text);
      this._boundary?.(null, { text: 'hello', audioOffset: 1_000_000, duration: 4_000_000 });
      this._boundary?.(null, { text: ',', audioOffset: 5_000_000, duration: 100_000 });
      onDone({ reason: ResultReason.SynthesizingAudioCompleted, audioData: wav(220, 1) });
    },
    close() {},
  });
}

test('快取命中就不合成、也不扣額度', async () => {
  const doc = { hopSec: 0.01, points: [1, 2, 3], words: [] };
  const store = fakeStore({ 'v/5': doc });
  let spent = 0;

  const result = await getReferencePitch({
    id: 5, text: 'hello', store, voice: 'v',
    spend: () => { spent += 1; return { allowed: true }; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.cached, true);
  assert.equal(result.doc, doc);
  assert.equal(spent, 0, '快取命中卻扣了額度');
  assert.equal(store.writes, 0);
});

test('快取沒中才合成，而且存起來', async () => {
  const store = fakeStore();
  const said = [];

  const result = await getReferencePitch({
    id: 5, text: 'hello there', store, voice: 'v',
    spend: () => ({ allowed: true }),
    synthesizerFactory: fakeSynth(said),
  });

  assert.equal(result.ok, true);
  assert.equal(result.cached, false);
  assert.deepEqual(said, ['hello there']);
  assert.equal(store.writes, 1);
  // 標點也會發 wordBoundary，但標在圖上只是雜訊
  assert.deepEqual(result.doc.words.map((w) => w.word), ['hello']);
  assert.equal(result.doc.words[0].start, 0.1);

  // 第二次就是讀快取了
  const again = await getReferencePitch({
    id: 5, text: 'hello there', store, voice: 'v',
    spend: () => assert.fail('第二次不該再扣額度'),
    synthesizerFactory: () => assert.fail('第二次不該再合成'),
  });
  assert.equal(again.cached, true);
});

test('額度扣不到就不合成 —— 分數與講評不受影響，只是沒有範例曲線', async () => {
  const store = fakeStore();
  const result = await getReferencePitch({
    id: 5, text: 'hello', store, voice: 'v',
    spend: () => ({ allowed: false, reason: 'total' }),
    synthesizerFactory: () => assert.fail('額度扣不到卻還是合成了'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'quota');
  assert.equal(store.writes, 0);
});

test('空的或過長的句子不會送去合成', async () => {
  const store = fakeStore();
  for (const text of ['', '   ', 'x'.repeat(401)]) {
    const result = await getReferencePitch({
      id: 1, text, store, voice: 'v',
      spend: () => assert.fail('不該扣額度'),
      synthesizerFactory: () => assert.fail('不該合成'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad_text');
  }
});

test('存不進去不算失敗 —— 這一次照樣看得到圖', async () => {
  const store = fakeStore();
  store.writePitch = async () => { throw new Error('磁碟滿了'); };

  const result = await getReferencePitch({
    id: 5, text: 'hello', store, voice: 'v',
    spend: () => ({ allowed: true }),
    synthesizerFactory: fakeSynth(),
  });
  assert.equal(result.ok, true);
});

// ─── 兩條曲線怎麼對齊 ────────────────────────────────────────────────────
//
// 這一段是這個功能最容易錯的地方：對錯了的症狀是「圖上看起來我整段語調都不對」，
// 而其實只是節奏不同 —— 而且不會有任何錯誤訊息。

const refPoints = (n, st = 0) =>
  Array.from({ length: n }, (_, i) => ({ t: i * 0.01, st: st + i * 0.1 }));

test('逐字對齊：我唸得慢，範例的字會被拉長到我的字上', () => {
  const reference = {
    contour: { hopSec: 0.01, points: refPoints(100) },
    words: [{ word: 'a', start: 0, duration: 0.5 }, { word: 'b', start: 0.5, duration: 0.5 }],
  };
  // 我唸了兩秒（範例的兩倍慢），而且第二個字特別拖
  const mine = [{ word: 'a', start: 0, duration: 0.6 }, { word: 'b', start: 0.6, duration: 1.4 }];

  const aligned = alignReference(reference, { words: mine, endSec: 2 });

  // 範例第一個字的正中間（0.25 秒）→ 我第一個字的正中間（0.3 秒）
  const mid = aligned[25];
  assert.ok(Math.abs(mid.t - 0.3) < 0.02, `${mid.t}`);
  // 範例第二個字的開頭（0.5）→ 我第二個字的開頭（0.6）
  assert.ok(Math.abs(aligned[50].t - 0.6) < 0.02, `${aligned[50].t}`);
  // 半音不會被改到 —— 對齊動的是時間軸，不是高低
  assert.equal(aligned[25].st, reference.contour.points[25].st);
});

test('字數對不上就退回整句按比例（硬對會把第 3 個字對到第 5 個字上）', () => {
  const reference = {
    contour: { hopSec: 0.01, points: refPoints(100) },
    words: [{ word: 'a', start: 0, duration: 0.5 }, { word: 'b', start: 0.5, duration: 0.5 }],
  };
  // 我這邊只認出一個字（漏唸、或 Azure 少認了）
  const mine = [{ word: 'a', start: 0, duration: 2 }];

  const aligned = alignReference(reference, { words: mine, endSec: 2 });
  // 整句拉成兩倍：第 50 格（0.5 秒）→ 1 秒
  assert.ok(Math.abs(aligned[50].t - 1) < 0.02, `${aligned[50].t}`);
});

test('沒有逐字時間也對得起來（Gemini 那條路沒有字）', () => {
  const reference = { contour: { hopSec: 0.01, points: refPoints(100) }, words: [] };
  const aligned = alignReference(reference, { words: [], endSec: 3 });
  assert.ok(Math.abs(aligned[50].t - 1.5) < 0.02, `${aligned[50].t}`);
});

test('無聲的格子對齊之後還是無聲', () => {
  const points = refPoints(10);
  points[3] = null;
  const aligned = alignReference({ contour: { hopSec: 0.01, points }, words: [] },
    { words: [], endSec: 0.1 });
  assert.equal(aligned[3], null);
});

test('沒有範例就回空陣列，不會炸', () => {
  assert.deepEqual(alignReference(null, {}), []);
  assert.deepEqual(alignReference({}, {}), []);
  assert.deepEqual(alignReference({ contour: { points: [] } }, {}), []);
});
