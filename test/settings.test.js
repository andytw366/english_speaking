// 設定的搬家規則（`public/lib/settings.js` 的 `migrate()`）。
//
// 為什麼值得測：搬家錯了**沒有任何錯誤訊息** —— 使用者設過的 50 會無聲變回 20，
// 或者一個數字的單位換了、數字沒換算，目標從此永遠達不到。
// 兩種都只會讓人覺得「這個設定頁不太可靠」，而不會有人來回報 bug。
//
// `settings.js` 只在函式裡碰 localStorage，所以塞一個假的就 import 得進來。

import test from 'node:test';
import assert from 'node:assert/strict';

/** 每條測試各自從乾淨的模組狀態開始 —— settings.js 有一個模組層級的 cache。 */
async function withStored(stored, fn) {
  const store = stored === null ? {} : { 'speaking-coach:settings': JSON.stringify(stored) };
  globalThis.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  // 加上 query string 讓每次都是新的模組實例（cache 不會跨測試殘留）
  const mod = await import(`../public/lib/settings.js?t=${Math.random()}`);
  return fn(mod, store);
}

test('全新安裝拿到預設值', async () => {
  await withStored(null, ({ goalOf, DEFAULTS }) => {
    assert.equal(goalOf('listening'), DEFAULTS.dailyGoals.listening);
    assert.equal(goalOf('vocabulary'), 20);
  });
});

test('聽力目標從「題」換算成「組」', async () => {
  // 今天的進度從「答完幾題」改成「答完幾組」之後，存著的數字**意思變了**。
  // 不換算的話，原本設 6 題（約兩組）會變成 6 組，怎麼練都達不到，
  // 而且畫面上沒有任何徵兆說「這個數字換單位了」。一組平均 2.8 題，所以除以 3。
  await withStored({ dailyGoals: { listening: 6 } }, ({ goalOf }) => {
    assert.equal(goalOf('listening'), 2);
  });
  await withStored({ dailyGoals: { listening: 12 } }, ({ goalOf }) => {
    assert.equal(goalOf('listening'), 4);
  });
});

test('換算不會把小的目標變成 0', async () => {
  // 0 的意思是「不設目標」。設過 2 題的人換算成 0 的話，
  // 今天的進度卡會整個消失 —— 那不是他要的，他只是目標很小
  await withStored({ dailyGoals: { listening: 2 } }, ({ goalOf }) => {
    assert.equal(goalOf('listening'), 1);
  });
});

test('本來就設 0（不設目標）的人維持 0', async () => {
  await withStored({ dailyGoals: { listening: 0 } }, ({ goalOf }) => {
    assert.equal(goalOf('listening'), 0);
  });
});

test('換算只做一次 —— 靠旗標，不是靠數字大小', async () => {
  // 6 在兩種單位下都是合法的值，光看數字分不出換算過沒有。
  // 沒有旗標的話，跑第二次會把 2 再除成 1，數字每次開 App 都變小
  await withStored({ listeningGoalInSets: true, dailyGoals: { listening: 6 } }, ({ goalOf }) => {
    assert.equal(goalOf('listening'), 6);
  });
});

test('換算只碰使用者設過的值，不碰預設值', async () => {
  // migrate() 如果收的是併好 DEFAULTS 的版本，就分不出「使用者設過 2」與
  // 「這是預設值 2」，全新安裝的目標會被一起除下去。真的踩過
  await withStored({ ttsRate: 1.1 }, ({ goalOf, DEFAULTS }) => {
    assert.equal(goalOf('listening'), DEFAULTS.dailyGoals.listening);
  });
});

test('換算之後其他模式的目標一個都不能動', async () => {
  await withStored(
    { dailyGoals: { vocabulary: 50, listening: 6, translation: 30, dialogue: 10, shadowing: 20 } },
    ({ goalOf }) => {
      assert.equal(goalOf('vocabulary'), 50);
      assert.equal(goalOf('translation'), 30);
      assert.equal(goalOf('dialogue'), 10);
      assert.equal(goalOf('shadowing'), 20);
    }
  );
});

test('更早的兩代搬家還是要通', async () => {
  // sessionLimit（一輪幾張）→ vocabDailyGoal（一天幾個字）→ dailyGoals
  await withStored({ sessionLimit: 50 }, ({ goalOf }) => {
    assert.equal(goalOf('vocabulary'), 50);
  });
  await withStored({ vocabDailyGoal: 35, shadowingGoal: 8 }, ({ goalOf }) => {
    assert.equal(goalOf('vocabulary'), 35);
    assert.equal(goalOf('shadowing'), 8);
  });
});

test('壞掉的設定不會讓整個 App 起不來', async () => {
  globalThis.localStorage = {
    getItem: () => '{ 這不是 JSON',
    setItem: () => {},
    removeItem: () => {},
  };
  const { getSettings, DEFAULTS } = await import(`../public/lib/settings.js?t=${Math.random()}`);
  assert.deepEqual(getSettings().dailyGoals, DEFAULTS.dailyGoals);
});

test('聽力的單位是「組」，而且跟每日目標的選項對得起來', async () => {
  // 單位與選項分在兩個檔案（modes.js / settings.js 的 GOAL_CHOICES），
  // 改一邊忘了另一邊的症狀是「畫面上寫 8 組，但預設值是照題數挑的 20」
  const { modeMeta } = await import('../public/lib/modes.js');
  assert.equal(modeMeta('listening').unit, '組');
  assert.equal(modeMeta('listening').todayLabel, '今天練的題組');
});
