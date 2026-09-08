// 兩份學習進度怎麼合成一份（`public/lib/merge.js`）。
//
// 這是整個跨裝置同步裡最不能出錯的一段：**合併寫錯是靜悄悄的**，
// 使用者看到的只是「咦，昨天練的怎麼不見了」，不會有任何錯誤訊息。
//
// 所以除了逐條規則之外，最重要的是兩個**性質**（下面每一種資料都各驗一次）：
//   冪等   merge(merge(a,b), b) === merge(a,b)   不然重試一次數字就膨脹
//   交換律 merge(a,b) === merge(b,a)             不然同步順序會影響結果，
//                                               兩台裝置會一直互相推翻

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeActivity, mergeDayNumbers, mergeHistory, mergeReviews, mergeSettings, mergeSrs, mergeState,
} from '../public/lib/merge.js';

/** 兩個性質一起驗。每一種資料都跑一次。 */
function assertWellBehaved(a, b, label) {
  const once = mergeState(a, b);

  assert.deepEqual(mergeState(once, b), once, `${label}：不冪等（重試一次結果就變了）`);
  assert.deepEqual(mergeState(once, a), once, `${label}：不冪等（跟自己的來源合也該不變）`);
  assert.deepEqual(mergeState(b, a), once, `${label}：不滿足交換律（同步順序會影響結果）`);
  // 合過再合一次自己，也不該變
  assert.deepEqual(mergeState(once, once), once, `${label}：跟自己合會變`);

  return once;
}

// ─── activity：計數表（最容易寫錯的一個）──────────────────────────────────

test('計數表：兩台裝置同一天各練各的，合起來是總和', () => {
  // 取 max 會少算（得到 3）、相加會不冪等（重試變 10）。
  // 每台一格 + 逐格取 max 才同時不少算也不膨脹
  const phone = { activity: { listening: { '2026-09-06': { 'dev-a': 3 } } } };
  const desk = { activity: { listening: { '2026-09-06': { 'dev-b': 2 } } } };

  const merged = assertWellBehaved(phone, desk, '計數表');
  assert.deepEqual(merged.activity.listening['2026-09-06'], { 'dev-a': 3, 'dev-b': 2 });
});

test('計數表：合併三次也不會膨脹', () => {
  // 這條直接把「相加」那種寫法釘死 —— 相加的話這裡會變成 15
  const phone = { activity: { listening: { '2026-09-06': { 'dev-a': 3 } } } };
  const desk = { activity: { listening: { '2026-09-06': { 'dev-b': 2 } } } };

  let m = mergeState(phone, desk);
  for (let i = 0; i < 3; i++) m = mergeState(m, i % 2 ? phone : desk);

  const slots = m.activity.listening['2026-09-06'];
  assert.equal(Object.values(slots).reduce((x, y) => x + y, 0), 5);
});

test('計數表：同一台裝置的格子取比較大的（那就是它的最新值）', () => {
  // 同一格只有一台裝置會動它，所以取 max 等於取那台的最新值
  const older = { activity: { vocabulary: { '2026-09-06': { 'dev-a': 5 } } } };
  const newer = { activity: { vocabulary: { '2026-09-06': { 'dev-a': 12 } } } };

  const merged = assertWellBehaved(older, newer, '同一格');
  assert.deepEqual(merged.activity.vocabulary['2026-09-06'], { 'dev-a': 12 });
});

test('計數表：舊形狀（一天一個數字）搬進固定的 legacy 格', () => {
  // **不可以搬進本機那一格** —— 兩台裝置各搬一次的話，
  // 同一段歷史會被算成兩台的份而加倍
  const merged = mergeActivity(
    { listening: { '2026-09-01': 4 } },
    { listening: { '2026-09-01': { 'dev-b': 1 } } },
  );
  assert.deepEqual(merged.listening['2026-09-01'], { legacy: 4, 'dev-b': 1 });
});

test('計數表：兩邊都還是舊形狀時，legacy 格取比較大的（不是相加）', () => {
  // 同步之前的歷史兩邊都各記過一份，相加會憑空多出一倍。
  // 略為少算是刻意的取捨：那些值只餵連續天數（看那天有沒有練過）
  const merged = mergeActivity(
    { listening: { '2026-09-01': 2 } },
    { listening: { '2026-09-01': 3 } },
  );
  assert.deepEqual(merged.listening['2026-09-01'], { legacy: 3 });
});

test('計數表：不同天、不同模式互不影響', () => {
  const a = { activity: { listening: { '2026-09-05': { 'dev-a': 1 } } } };
  const b = { activity: { vocabulary: { '2026-09-06': { 'dev-b': 20 } } } };
  const merged = assertWellBehaved(a, b, '不同模式');
  assert.equal(merged.activity.listening['2026-09-05']['dev-a'], 1);
  assert.equal(merged.activity.vocabulary['2026-09-06']['dev-b'], 20);
});

test('計數表：只留最近 400 天，而且留下來的是最新的', () => {
  const days = {};
  for (let i = 0; i < 450; i++) {
    days[`2020-01-01+${String(i).padStart(4, '0')}`] = { 'dev-a': 1 };
  }
  const merged = mergeActivity({ vocabulary: days }, {});
  const keys = Object.keys(merged.vocabulary);
  assert.equal(keys.length, 400);
  assert.ok(keys.includes('2020-01-01+0449'), '最新的一天被丟掉了');
  assert.ok(!keys.includes('2020-01-01+0000'), '最舊的一天沒有被丟掉');
});

test('計數表：壞掉的值當成沒有（localStorage 是使用者改得到的）', () => {
  const merged = mergeActivity(
    { listening: { '2026-09-06': { 'dev-a': 'abc', 'dev-b': -5, 'dev-c': 2.9 } } },
    {},
  );
  assert.deepEqual(merged.listening['2026-09-06'], { 'dev-c': 2 });
});

// ─── srs：每張卡取比較新的那一次 ─────────────────────────────────────────

test('複習進度：每張卡取 at 比較新的整筆', () => {
  const older = { srs: { 'ecdict:1': { box: 2, due: 500, seen: 3, correct: 2, at: 100 } } };
  const newer = { srs: { 'ecdict:1': { box: 1, due: 200, seen: 4, correct: 2, at: 900 } } };

  const merged = assertWellBehaved(older, newer, '複習進度');
  // 整筆取新的：box 是 1（答錯回第一盒）而不是 2
  assert.deepEqual(merged.srs['ecdict:1'], { box: 1, due: 200, seen: 4, correct: 2, at: 900 });
});

test('複習進度：due 不能拿來判斷新舊', () => {
  // box 4 一週前答的卡，due 比 box 1 今天剛答的還晚 ——
  // 用 due 判斷的話會挑到舊的那一筆，而那張卡的排程就錯了
  const weekAgoBox4 = { box: 4, due: 9_000_000, seen: 8, correct: 7, at: 1_000 };
  const todayBox1 = { box: 1, due: 100, seen: 9, correct: 7, at: 5_000 };

  const merged = mergeSrs({ x: weekAgoBox4 }, { x: todayBox1 });
  assert.equal(merged.x.box, 1, '挑到了 due 比較晚的那一筆（錯的）');
});

test('複習進度：只有一邊有 at 時取有 at 的（另一邊是加欄位之前練的）', () => {
  const withAt = { box: 2, seen: 2, at: 50 };
  const legacy = { box: 5, seen: 9 };
  assert.deepEqual(mergeSrs({ x: withAt }, { x: legacy }).x, withAt);
  assert.deepEqual(mergeSrs({ x: legacy }, { x: withAt }).x, withAt);
});

test('複習進度：都沒有 at 時退回看答過幾次', () => {
  assert.equal(mergeSrs({ x: { box: 1, seen: 2 } }, { x: { box: 3, seen: 7 } }).x.seen, 7);
});

test('複習進度：完全分不出新舊時的選擇是決定性的', () => {
  // 隨便挑的話，兩台裝置每次同步都會得到不同結果，然後 rev 一直往上跳、
  // 互相推翻，而畫面上看起來像進度會自己變
  const x = { box: 2, seen: 3, at: 100 };
  const y = { box: 3, seen: 3, at: 100 };
  const first = mergeSrs({ k: x }, { k: y }).k;
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(mergeSrs({ k: x }, { k: y }).k, first);
    assert.deepEqual(mergeSrs({ k: y }, { k: x }).k, first, '換邊之後挑到不一樣的');
  }
});

test('複習進度：只有一邊有那張卡就直接收下', () => {
  const merged = mergeSrs({ a: { box: 1, at: 1 } }, { b: { box: 2, at: 2 } });
  assert.deepEqual(Object.keys(merged).sort(), ['a', 'b']);
});

// ─── history：取聯集 ─────────────────────────────────────────────────────

test('跟讀紀錄：取聯集，依時間由新到舊', () => {
  const a = { history: [{ at: '2026-09-06T10:00:00.000Z', sentenceId: 1, score: 80 }] };
  const b = { history: [{ at: '2026-09-06T11:00:00.000Z', sentenceId: 2, score: 90 }] };

  const merged = assertWellBehaved(a, b, '跟讀紀錄');
  assert.equal(merged.history.length, 2);
  assert.equal(merged.history[0].sentenceId, 2, '沒有由新到舊排');
});

test('跟讀紀錄：同一筆不會變成兩筆', () => {
  const one = { at: '2026-09-06T10:00:00.000Z', sentenceId: 7, score: 80 };
  assert.equal(mergeHistory([one], [{ ...one }]).length, 1);
});

test('跟讀紀錄：同一句不同時間是兩筆', () => {
  const a = [{ at: '2026-09-06T10:00:00.000Z', sentenceId: 7 }];
  const b = [{ at: '2026-09-06T12:00:00.000Z', sentenceId: 7 }];
  assert.equal(mergeHistory(a, b).length, 2);
});

test('跟讀紀錄：截到 200 筆，留下的是最新的', () => {
  const make = (n, from) => Array.from({ length: n }, (_, i) => ({
    at: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T0${i % 10}:00:00.000Z`,
    sentenceId: from + i,
  }));
  const merged = mergeHistory(make(150, 0), make(150, 1000));
  assert.equal(merged.length, 200);
  assert.equal(merged[0].at, merged.map((r) => r.at).sort().reverse()[0]);
});

// ─── settings：整包取新的 ────────────────────────────────────────────────

test('設定：整包取 updatedAt 比較新的那一邊', () => {
  // 逐欄位合併會產生「一半舊一半新」的組合 —— 而那個組合是使用者
  // 從來沒有選過的狀態（語速是新的、題型是舊的）
  const old = { settings: { ttsRate: 0.9, translationType: 'cloze', updatedAt: 100 } };
  const fresh = { settings: { ttsRate: 1.2, translationType: 'all', updatedAt: 999 } };

  const merged = assertWellBehaved(old, fresh, '設定');
  assert.deepEqual(merged.settings, fresh.settings);
});

test('設定：只有一邊有 updatedAt 時取有的那一邊', () => {
  const withStamp = { ttsRate: 1.1, updatedAt: 5 };
  const legacy = { ttsRate: 0.8 };
  assert.deepEqual(mergeSettings(withStamp, legacy), withStamp);
  assert.deepEqual(mergeSettings(legacy, withStamp), withStamp);
});

test('設定：時間戳一樣時的選擇是決定性的', () => {
  const a = { ttsRate: 0.9, updatedAt: 7 };
  const b = { ttsRate: 1.5, updatedAt: 7 };
  assert.deepEqual(mergeSettings(a, b), mergeSettings(b, a));
});

// ─── 整份 ────────────────────────────────────────────────────────────────

test('沒有的鍵不會憑空長出來', () => {
  // 空物件合空物件應該還是空的 —— 補上空的 srs / activity 會讓
  // 「這台裝置還沒有任何進度」跟「練過但清掉了」變得分不出來
  assert.deepEqual(mergeState({}, {}), {});
  assert.deepEqual(mergeState(null, undefined), {});
});

test('一邊是空的時候，另一邊整份留下來', () => {
  const state = {
    srs: { 'ecdict:1': { box: 2, at: 5 } },
    activity: { listening: { '2026-09-06': { 'dev-a': 2 } } },
    history: [{ at: '2026-09-06T10:00:00.000Z', sentenceId: 1 }],
    settings: { ttsRate: 1, updatedAt: 3 },
    srsVersion: 2,
  };
  assert.deepEqual(mergeState(state, {}), mergeState({}, state));
  assert.deepEqual(mergeState(state, {}).srs, state.srs);
  assert.deepEqual(mergeState(state, {}).history, state.history);
});

test('srsVersion 取大的（搬家版本只會往前）', () => {
  assert.equal(mergeState({ srsVersion: 1 }, { srsVersion: 2 }).srsVersion, 2);
  assert.equal(mergeState({ srsVersion: 2 }, {}).srsVersion, 2);
});

// ─── reviews：情境對話的 AI 修正 ─────────────────────────────────────────

test('AI 修正：兩台裝置練過的段落合起來，不是整包取一邊', () => {
  // 每一筆都是一次花錢的呼叫。整包取新的那一邊會把另一台練過的丟掉，
  // 而丟掉的代價是下次練到那一段時再付一次錢
  const phone = {
    reviews: {
      '1:1': { input: 'I want a latte', corrected: 'Can I get a latte?', at: '2026-09-06T01:00:00.000Z' },
    },
  };
  const desk = {
    reviews: {
      '7:3': { input: 'Where is toilet', corrected: 'Where is the restroom?', at: '2026-09-06T02:00:00.000Z' },
    },
  };

  const merged = assertWellBehaved(phone, desk, 'AI 修正');
  assert.deepEqual(Object.keys(merged.reviews).sort(), ['1:1', '7:3']);
});

test('AI 修正：同一格取比較新的那一次', () => {
  // 使用者改了句子再問一次，舊的那份講的是另一句話 —— 留著會對不上
  const older = {
    reviews: { '1:1': { input: 'I want latte', corrected: 'A latte, please.', at: '2026-09-06T01:00:00.000Z' } },
  };
  const newer = {
    reviews: { '1:1': { input: 'I want a latte to go', corrected: 'Can I get a latte to go?', at: '2026-09-07T01:00:00.000Z' } },
  };

  const merged = assertWellBehaved(older, newer, 'AI 修正（同一格）');
  assert.equal(merged.reviews['1:1'].input, 'I want a latte to go');
});

test('AI 修正：超過上限時兩邊丟掉的是同一批', () => {
  // 排序只比 at 的話，時間一樣的幾筆會維持進來的順序 —— 那取決於哪一邊先合
  const make = (offset) => Object.fromEntries(
    Array.from({ length: 150 }, (_, i) => [
      `d${offset}:${i}`,
      { input: `line ${i}`, corrected: 'x', at: '2026-09-06T00:00:00.000Z' },
    ])
  );
  const a = { reviews: make(1) };
  const b = { reviews: make(2) };

  const merged = assertWellBehaved(a, b, 'AI 修正（超過上限）');
  assert.equal(Object.keys(merged.reviews).length, 200);
});

test('AI 修正：只有一邊有的時候原樣帶過去', () => {
  const only = { reviews: { '1:1': { input: 'hi', at: '2026-09-06T00:00:00.000Z' } } };
  assert.deepEqual(mergeReviews(only.reviews, undefined), only.reviews);
  assert.deepEqual(mergeReviews(undefined, only.reviews), only.reviews);
  assert.equal(mergeReviews(undefined, undefined), undefined);
  // 壞掉的形狀（陣列、字串）不能讓合併爆掉
  assert.deepEqual(mergeReviews(['x'], only.reviews), only.reviews);
});

test('隨機的兩台裝置操作序列都滿足冪等與交換律', () => {
  // 上面每一條都是舉例；這一條負責掃邊界。
  // 失敗的話會印出那一組資料，可以直接拿去寫成一條新的測試
  const rnd = seeded(20260907);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  for (let round = 0; round < 300; round++) {
    const gen = () => {
      const state = {};
      if (rnd() < 0.8) {
        state.activity = {};
        for (const mode of ['vocabulary', 'listening', 'shadowing'].slice(0, 1 + Math.floor(rnd() * 3))) {
          const days = {};
          for (let d = 0; d < 1 + Math.floor(rnd() * 3); d++) {
            const day = `2026-09-0${1 + Math.floor(rnd() * 9)}`;
            // 有時候是新形狀、有時候是舊形狀（還沒搬過的 localStorage）
            days[day] = rnd() < 0.25
              ? Math.floor(rnd() * 20)
              : { [pick(['dev-a', 'dev-b', 'legacy'])]: 1 + Math.floor(rnd() * 20) };
          }
          state.activity[mode] = days;
        }
      }
      if (rnd() < 0.7) {
        state.srs = {};
        for (let i = 0; i < 1 + Math.floor(rnd() * 4); i++) {
          const key = `ecdict:${1 + Math.floor(rnd() * 5)}`;
          state.srs[key] = {
            box: 1 + Math.floor(rnd() * 5),
            due: Math.floor(rnd() * 1e6),
            seen: Math.floor(rnd() * 10),
            correct: Math.floor(rnd() * 10),
            ...(rnd() < 0.8 ? { at: Math.floor(rnd() * 1e6) } : {}),
          };
        }
      }
      if (rnd() < 0.6) {
        state.settings = {
          ttsRate: Number(rnd().toFixed(2)),
          ...(rnd() < 0.8 ? { updatedAt: Math.floor(rnd() * 1000) } : {}),
        };
      }
      if (rnd() < 0.5) {
        state.reviews = {};
        for (let i = 0; i < Math.floor(rnd() * 4); i++) {
          state.reviews[`${1 + Math.floor(rnd() * 3)}:${Math.floor(rnd() * 5)}`] = {
            input: pick(['I want a latte', 'Where is toilet', 'How much']),
            corrected: pick(['Can I get a latte?', 'Where is the restroom?', null]),
            verdict: pick(['ok', 'minor', 'major']),
            at: `2026-09-0${1 + Math.floor(rnd() * 9)}T0${Math.floor(rnd() * 10)}:00:00.000Z`,
          };
        }
      }
      if (rnd() < 0.5) {
        state.history = Array.from({ length: Math.floor(rnd() * 4) }, () => ({
          at: `2026-09-0${1 + Math.floor(rnd() * 9)}T0${Math.floor(rnd() * 10)}:00:00.000Z`,
          sentenceId: 1 + Math.floor(rnd() * 5),
          score: Math.floor(rnd() * 100),
        }));
      }
      return state;
    };

    const a = gen();
    const b = gen();
    const once = mergeState(a, b);
    const why = () => `\n第 ${round} 輪\na=${JSON.stringify(a)}\nb=${JSON.stringify(b)}`;

    assert.deepEqual(mergeState(b, a), once, `不滿足交換律${why()}`);
    assert.deepEqual(mergeState(once, b), once, `不冪等（再合 b）${why()}`);
    assert.deepEqual(mergeState(once, a), once, `不冪等（再合 a）${why()}`);
    assert.deepEqual(mergeState(once, once), once, `跟自己合會變${why()}`);
  }
});

/** 固定種子的亂數 —— 失敗的那一輪要重現得出來，不然修不了。 */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
