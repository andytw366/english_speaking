// 情境對話 AI 修正的本機快取（`public/lib/storage.js` 的 reviews 那一段）。
//
// 為什麼值得測：這份東西**同時是快取與紀錄**，而快取那一半錯了會花到錢
// （同一句話再問一次）或給出錯的東西（句子改過了卻拿舊的修正）。
// 兩種都不會有錯誤訊息 —— 前者只是帳單多一點，後者是「AI 說的跟我寫的對不上」。
//
// `storage.js` 只在函式裡碰 localStorage，所以塞一個假的就 import 得進來
// （跟 `settings.test.js` 同一招）。

import test from 'node:test';
import assert from 'node:assert/strict';

async function withStorage(fn, { initial = {} } = {}) {
  const store = { ...initial };
  globalThis.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  // 每次都是新的模組實例 —— storage.js 有模組層級的狀態（搬家只跑一次）
  const mod = await import(`../public/lib/storage.js?t=${Math.random()}`);
  return fn(mod, store);
}

test('存了就讀得回來，而且帶著時間', async () => {
  await withStorage(({ saveReview, getReviews, reviewKey }) => {
    saveReview(reviewKey(7, 3), {
      input: 'I want a latte',
      corrected: 'Can I get a latte, please?',
      verdict: 'minor',
      notes: ['點餐用 Can I get… 比較自然。'],
      label: 'router.huggingface.co',
    }, Date.parse('2026-09-08T03:00:00.000Z'));

    const entry = getReviews()['7:3'];
    assert.equal(entry.corrected, 'Can I get a latte, please?');
    assert.equal(entry.input, 'I want a latte');
    assert.equal(entry.at, '2026-09-08T03:00:00.000Z');
  });
});

test('同一格再存一次是覆蓋，不是留兩份', async () => {
  // 使用者改了句子再問一次時，舊的那份講的是另一句話 —— 留著只會在下次比對時
  // 給出錯的快取
  await withStorage(({ saveReview, getReviews }) => {
    saveReview('7:3', { input: 'a', corrected: 'A.' });
    saveReview('7:3', { input: 'b', corrected: 'B.' });
    assert.equal(Object.keys(getReviews()).length, 1);
    assert.equal(getReviews()['7:3'].input, 'b');
  });
});

test('超過上限時丟掉最舊的，留下最新的', async () => {
  await withStorage(({ saveReview, getReviews }) => {
    for (let i = 0; i < 220; i++) {
      saveReview(`d:${i}`, { input: `line ${i}` }, Date.parse('2026-09-01T00:00:00.000Z') + i * 1000);
    }
    const all = getReviews();
    assert.equal(Object.keys(all).length, 200);
    assert.ok(all['d:219'], '最新的那筆要留著');
    assert.ok(!all['d:0'], '最舊的那筆該被丟掉');
  });
});

test('丟掉最舊的是看時間，不是看鍵的順序', async () => {
  // 同步合併回來之後，物件的鍵順序不保證還是時間順序
  await withStorage(({ saveReview, getReviews }) => {
    const base = Date.parse('2026-09-01T00:00:00.000Z');
    // 先存一筆很新的，再存滿 200 筆舊的
    saveReview('keep:me', { input: '新的' }, base + 10_000_000);
    for (let i = 0; i < 200; i++) saveReview(`old:${i}`, { input: `舊的 ${i}` }, base + i);
    const all = getReviews();
    assert.equal(Object.keys(all).length, 200);
    assert.ok(all['keep:me'], '時間最新的那筆要留著，不管它是第幾個存進去的');
  });
});

test('壞掉的值當成沒有（localStorage 是使用者改得到的）', async () => {
  await withStorage(({ getReviews }) => {
    assert.deepEqual(getReviews(), {});
  }, { initial: { 'speaking-coach:reviews': '["不是物件"]' } });

  await withStorage(({ getReviews }) => {
    assert.deepEqual(getReviews(), {});
  }, { initial: { 'speaking-coach:reviews': '{壞掉的 JSON' } });
});

test('清得掉', async () => {
  await withStorage(({ saveReview, clearReviews, getReviews }) => {
    saveReview('1:1', { input: 'x' });
    clearReviews();
    assert.deepEqual(getReviews(), {});
  });
});

test('進得了備份（BACKUP_KEYS 裡有它）', async () => {
  // 這份東西是**花錢換來的**：漏掉的話換一台裝置就得重新付一次
  const { BACKUP_KEYS, buildBackup, backupSummary, summaryText } =
    await import('../public/lib/backup.js');

  assert.ok(BACKUP_KEYS.includes('reviews'));

  const backup = buildBackup({ reviews: { '1:1': { input: 'x' }, '1:3': { input: 'y' } } });
  assert.equal(Object.keys(backup.data.reviews).length, 2);

  const summary = backupSummary(backup.data);
  assert.equal(summary.reviews, 2);
  assert.match(summaryText(summary), /AI 修正 2 筆/);
});

test('沒有 AI 修正時摘要不寫那一行 —— 沒開這個功能的人看到「0 筆」只會困惑', async () => {
  const { backupSummary, summaryText } = await import('../public/lib/backup.js');
  assert.doesNotMatch(summaryText(backupSummary({ srs: {} })), /AI 修正/);
});
