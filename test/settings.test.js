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

// ─── AI 功能：三個開關搬到同一組選項 ─────────────────────────────────────

test('三個 AI 功能預設都是自動', async () => {
  await withStored(null, ({ aiMode }) => {
    assert.equal(aiMode('narration'), 'auto');
    assert.equal(aiMode('dialogue'), 'auto');
    assert.equal(aiMode('translation'), 'auto');
  });
});

test('舊的 geminiNarration=false 搬成「關」', async () => {
  // 那時候沒有「手動」—— 關掉就是只看本地摘要。搬成 manual 會讓
  // 「我明明關掉了，怎麼還是有一顆按鈕」變成一個沒人解釋得了的變化
  await withStored({ geminiNarration: false }, ({ aiMode }) => {
    assert.equal(aiMode('narration'), 'off');
  });
});

test('舊的 dialogueAiReview=false 搬成「手動」', async () => {
  // 那時候關掉之後結果卡上按鈕還在，那就是現在的「手動」
  await withStored({ dialogueAiReview: false, translationAiReview: false }, ({ aiMode }) => {
    assert.equal(aiMode('dialogue'), 'manual');
    assert.equal(aiMode('translation'), 'manual');
  });
});

test('沒設過的舊鍵不會把別的功能一起關掉', async () => {
  await withStored({ geminiNarration: false }, ({ aiMode }) => {
    assert.equal(aiMode('dialogue'), 'auto');
    assert.equal(aiMode('translation'), 'auto');
  });
});

test('只設過其中一個功能時，另外兩個是預設值而不是 undefined', async () => {
  // `{...DEFAULTS, ...stored}` 是淺層的 —— 沒有特別併 `ai` 的話，
  // 另外兩個會變成 undefined，畫面上就看不出目前選了哪個
  await withStored({ ai: { dialogue: 'off' } }, ({ aiMode, getSettings }) => {
    assert.equal(aiMode('dialogue'), 'off');
    assert.equal(getSettings().ai.narration, 'auto');
    assert.equal(getSettings().ai.translation, 'auto');
  });
});

test('新的值蓋得過舊的布林值（搬過家之後改設定要生效）', async () => {
  await withStored({ geminiNarration: false, ai: { narration: 'manual' } }, ({ aiMode }) => {
    assert.equal(aiMode('narration'), 'manual');
  });
});

test('認不得的值當成自動 —— 功能整個消失比多花幾次呼叫難查得多', async () => {
  await withStored({ ai: { narration: '亂寫的' } }, ({ aiMode }) => {
    assert.equal(aiMode('narration'), 'auto');
  });
});

test('setAiMode 存得住，而且不會動到別的功能', async () => {
  // updateSettings() 會發一個 CustomEvent 給畫面 —— node 裡沒有 window，
  // 補一個最小的假的（這幾行不是在測事件，是為了讓存檔那一段跑得完）
  globalThis.window = { dispatchEvent: () => {} };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };

  await withStored({}, ({ setAiMode, aiMode }) => {
    setAiMode('translation', 'off');
    assert.equal(aiMode('translation'), 'off');
    assert.equal(aiMode('dialogue'), 'auto');
  });
});

test('三個功能的說明文字每一個模式都有一句', async () => {
  // 少一句的話那個選項按下去之後畫面上什麼都不會說 —— 而「選了會怎樣」
  // 正是使用者按下去之前想知道的事
  const { AI_FEATURES, AI_MODES } = await import('../public/lib/settings.js');
  assert.equal(AI_FEATURES.length, 3);
  for (const feature of AI_FEATURES) {
    for (const [mode] of AI_MODES) {
      assert.ok(feature[mode], `${feature.id} 少了「${mode}」的說明`);
    }
  }
});
