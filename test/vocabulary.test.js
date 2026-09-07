// 單字的難度分級：規則、資料，以及複習進度的鍵搬家。
//
// 三段各自擋不同的事：
//   tierFor      分級規則本身（純函式，建置腳本與這裡共用同一份）
//   資料         產出的 tier-*.json 與 index.json 對不對得起來
//   migrateSrs   舊鍵搬到新鍵。這段只跑一次，跑錯就是使用者的複習進度不見了
//   tierProgress 各級進度。它讀的是 20 KB 的對照表而不是 3 MB 的字庫，
//                所以算錯不會有任何症狀 —— 只有數字悄悄不對

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TIERS, TIER_IDS, tierFor } from '../scripts/vocab-levels.js';
import {
  migrateSrs, tierProgress, addActivity, activityCount, activityDays, activityToday,
  buildActivity, ACTIVITY_DAY_LIMIT, MODE_IDS,
} from '../public/lib/storage.js';
import { streakFromDays, dayKey } from '../public/lib/practice.js';
import { todayNote } from '../public/lib/today-card.js';

const DIR = path.join(import.meta.dirname, '..', 'content', 'vocabulary');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
const index = load('index.json');
const tierMap = load('tier-map.json');

// ─── 分級規則 ────────────────────────────────────────────────────────────

test('取最簡單的那個標籤 —— 國中就學過的字不是 GRE 單字', () => {
  assert.equal(tierFor({ tags: ['zk', 'gk', 'cet4', 'gre'] }), 'tier-1');
  assert.equal(tierFor({ tags: ['gre', 'zk'] }), 'tier-1');
  assert.equal(tierFor({ tags: ['cet6', 'toefl', 'gre'] }), 'tier-4');
  assert.equal(tierFor({ tags: ['toefl', 'gre'] }), 'tier-5');
  assert.equal(tierFor({ tags: ['gre'] }), 'tier-6');
});

test('標籤的順序不影響結果（tags 的排列是資料來源決定的，不能依賴）', () => {
  const shuffles = [['cet4', 'zk'], ['zk', 'cet4'], ['cet4', 'gk', 'zk']];
  for (const tags of shuffles) assert.equal(tierFor({ tags }), 'tier-1', tags.join(','));
});

test('沒有考試標籤的字用詞頻與 Collins 星等補位', () => {
  // 這些字沒進任何考試範圍，但很常用 —— 丟到「艱深」那一級是錯的
  assert.equal(tierFor({ rank: 800 }), 'tier-2');
  assert.equal(tierFor({ rank: 4200 }), 'tier-3');
  assert.equal(tierFor({ rank: 9500 }), 'tier-6');

  // Collins 星等自己就足夠：詞頻排名在後段會被專有名詞與領域詞干擾
  assert.equal(tierFor({ rank: 9500, collins: 5 }), 'tier-2');
  assert.equal(tierFor({ rank: 9500, collins: 3 }), 'tier-3');
  assert.equal(tierFor({ rank: 9500, collins: 1 }), 'tier-6');
});

test('沒見過的標籤不會讓字消失 —— 一律有一級收得下', () => {
  for (const w of [{}, { tags: [] }, { tags: ['made_up'] }, { tags: ['made_up'], rank: 3000 }]) {
    assert.ok(TIER_IDS.includes(tierFor(w)), JSON.stringify(w));
  }
});

// ─── 產出的資料 ──────────────────────────────────────────────────────────

test('index.json 列出精選、六個分級與十個詞頻級距', () => {
  const kinds = index.decks.reduce((acc, d) => ({ ...acc, [d.kind]: (acc[d.kind] ?? 0) + 1 }), {});
  assert.deepEqual(kinds, { curated: 1, tier: TIERS.length, band: 10 });

  // 精選一定要在裡面：它是預設牌組，而建置腳本不產生它（手寫的），
  // 只要腳本又把整個目錄砍掉重建，這一條就會紅
  assert.ok(index.decks.some((d) => d.id === 'curated'));
});

test('band 與 tier 共用複習進度的命名空間，精選自己一個', () => {
  // 這是「在 band-1 記熟的字換去 tier-1 練不會變回沒學過」的唯一保證
  for (const d of index.decks) {
    assert.equal(d.keyspace, d.kind === 'curated' ? 'curated' : 'ecdict', d.id);
  }
});

test('每個分級檔的字數與 index.json 一致，加起來剛好是全部', () => {
  let sum = 0;
  for (const deck of index.decks.filter((d) => d.kind === 'tier')) {
    const cards = load(deck.file);
    assert.equal(cards.length, deck.count, deck.id);
    assert.ok(cards.length > 0, `${deck.id} 是空的`);
    sum += cards.length;
  }
  assert.equal(sum, index.total);
});

test('每張卡都標了自己所屬的那一級', () => {
  for (const deck of index.decks.filter((d) => d.kind === 'tier')) {
    for (const card of load(deck.file)) {
      assert.equal(card.tier, deck.id, `${card.word} 在 ${deck.file} 裡卻標成 ${card.tier}`);
    }
  }
});

test('分級與詞頻級距是同一批字、同一組 id', () => {
  // id 就是全域詞頻排名，兩種切法共用。不一致的話複習進度會對不起來。
  const fromTiers = new Map();
  for (const deck of index.decks.filter((d) => d.kind === 'tier')) {
    for (const c of load(deck.file)) fromTiers.set(c.id, c.word);
  }
  const fromBands = new Map();
  for (const deck of index.decks.filter((d) => d.kind === 'band')) {
    for (const c of load(deck.file)) fromBands.set(c.id, c.word);
  }

  assert.equal(fromTiers.size, index.total);
  assert.equal(fromBands.size, index.total);
  for (const [id, word] of fromBands) {
    assert.equal(fromTiers.get(id), word, `id ${id} 在兩種切法裡是不同的字`);
  }
});

test('tier-map 的每一格都對得上該字實際所在的分級', () => {
  const order = new Map(tierMap.tiers.map((t) => [t.id, t.order]));
  assert.equal(tierMap.byId.length, index.total);

  for (const deck of index.decks.filter((d) => d.kind === 'tier')) {
    for (const card of load(deck.file)) {
      assert.equal(tierMap.byId[card.id - 1], order.get(deck.id), `id ${card.id}（${card.word}）`);
    }
  }
  // 每一格都要有值 —— undefined 會讓進度總覽默默少算一整級
  assert.ok(tierMap.byId.every((v) => typeof v === 'number'), 'byId 有空格');
});

test('每一級的字數都在可以練的範圍內（不會出現只有 60 個字的一級）', () => {
  // 考研（60 個字）與 GRE（312 個）當初就是因為太小才被合併進「艱深」那一級。
  // 這條釘住的是「分級規則改了之後不會又切出一個練不起來的級」。
  for (const t of tierMap.tiers) {
    assert.ok(t.count >= 500, `${t.label} 只有 ${t.count} 個字，太小`);
    assert.ok(t.count <= 3500, `${t.label} 有 ${t.count} 個字，太大`);
  }
});

test('卡片該有的欄位都在（缺了不會炸，只會畫出空白）', () => {
  // `pos` 刻意不在必填裡：ECDICT 有近兩成的詞條沒有詞性
  //（all、other、like、any… 都沒有），這是資料現況而不是 bug。
  // 畫面上那一格空著就好，不要為了填滿它去猜詞性。
  for (const deck of index.decks.filter((d) => d.kind === 'tier')) {
    for (const card of load(deck.file)) {
      for (const key of ['id', 'word', 'ipa', 'meaning_zh', 'difficulty', 'tier']) {
        assert.ok(card[key], `${deck.file} 的 ${card.word ?? card.id} 少了 ${key}`);
      }
    }
  }
});

test('沒有詞性的字仍然是少數（超過三成就代表清理邏輯壞了）', () => {
  const cards = index.decks.filter((d) => d.kind === 'tier').flatMap((d) => load(d.file));
  const missing = cards.filter((c) => !c.pos).length;
  assert.ok(missing / cards.length < 0.3, `${missing}/${cards.length} 張沒有詞性`);
});

// ─── 複習進度的鍵搬家 ────────────────────────────────────────────────────

test('band 的鍵搬到共用的 ecdict 命名空間', () => {
  assert.deepEqual(
    migrateSrs({ 'band-1:5': { box: 3, due: 1, seen: 4, correct: 3 } }),
    { 'ecdict:5': { box: 3, due: 1, seen: 4, correct: 3 } },
  );
  // 兩位數的 band 也要搬得動（band-10 是 id 9001 起算的那一組）
  assert.deepEqual(Object.keys(migrateSrs({ 'band-10:9500': { box: 1 } })), ['ecdict:9500']);
});

test('精選與跟讀的鍵不動', () => {
  const before = { 'curated:1': { box: 2 }, 'ecdict:7': { box: 5 }, '12': { box: 1 } };
  assert.deepEqual(migrateSrs(before), before);
});

test('搬完再搬一次結果一樣（migration 會在每次載入時被檢查）', () => {
  const once = migrateSrs({ 'band-2:1200': { box: 4, seen: 6 }, 'curated:3': { box: 1 } });
  assert.deepEqual(migrateSrs(once), once);
});

test('同一個字兩份進度時留比較前面的那一份 —— 合併不可以把人往回推', () => {
  const merged = migrateSrs({
    'band-1:5': { box: 1, seen: 1, correct: 0 },
    'ecdict:5': { box: 4, seen: 9, correct: 8 },
  });
  assert.equal(merged['ecdict:5'].box, 4);
  assert.equal(Object.keys(merged).length, 1);
});

test('壞掉的輸入不會炸 —— srs 是使用者改得到的 localStorage', () => {
  assert.deepEqual(migrateSrs(undefined), {});
  assert.deepEqual(migrateSrs(null), {});
  assert.doesNotThrow(() => migrateSrs({ 'band-1:5': null }));
});

// ─── 各級進度 ────────────────────────────────────────────────────────────

const MAP = {
  tiers: [
    { id: 'tier-1', order: 1, label: '入門', count: 3 },
    { id: 'tier-2', order: 2, label: '基礎', count: 2 },
  ],
  // id 1、2、5 是第一級，3、4 是第二級
  byId: [1, 1, 2, 2, 1],
};
const NOW = 1_700_000_000_000;
const box = (b, dueOffset) => ({ box: b, due: NOW + dueOffset, seen: 1, correct: 1 });

test('沒有任何進度時，每一級都是「全部沒學過」', () => {
  const [t1, t2] = tierProgress({}, MAP, NOW);
  assert.deepEqual(
    [t1.fresh, t1.learning, t1.mastered, t1.due],
    [3, 0, 0, 0],
  );
  assert.equal(t2.fresh, 2);
});

test('依盒子分成學習中與已熟練，到期的另外算', () => {
  const state = {
    'ecdict:1': box(5, -1000),   // 第 5 盒 = 熟練，而且已經到期
    'ecdict:2': box(2, 5000),    // 學習中，還沒到期
    'ecdict:3': box(5, 5000),    // 第二級，熟練
  };
  const [t1, t2] = tierProgress(state, MAP, NOW);

  assert.deepEqual([t1.mastered, t1.learning, t1.fresh, t1.due], [1, 1, 1, 1]);
  assert.deepEqual([t2.mastered, t2.learning, t2.fresh, t2.due], [1, 0, 1, 0]);
});

test('精選與跟讀的紀錄不會被算進分級進度', () => {
  const state = { 'curated:1': box(5, -1), '12': box(5, -1), 'ecdict:1': box(5, -1) };
  const [t1] = tierProgress(state, MAP, NOW);
  assert.equal(t1.mastered, 1);
  assert.equal(t1.seen, 1);
});

test('超出範圍的 id 被忽略而不是算到某一級去', () => {
  // 重建資料時字庫可能變短，舊進度會留著超出範圍的鍵
  const [t1, t2] = tierProgress({ 'ecdict:9999': box(5, -1) }, MAP, NOW);
  assert.equal(t1.seen + t2.seen, 0);
});

test('拿真實的 tier-map 跑得動，而且每一級的總數都對', () => {
  const rows = tierProgress({ 'ecdict:1': box(5, -1) }, tierMap, NOW);
  assert.equal(rows.length, tierMap.tiers.length);
  for (const r of rows) {
    assert.equal(r.fresh + r.learning + r.mastered, r.count, r.label);
  }
});

test('對照表載不到時回空陣列，不是丟例外（總覽只是不畫，練習照常）', () => {
  assert.deepEqual(tierProgress({}, null, NOW), []);
  assert.deepEqual(tierProgress({}, {}, NOW), []);
});

// ─── 每天練了什麼（六個模式共用的計數表）──────────────────────────────────
//
// 舊的「一輪最多幾張」關掉重開就再來一輪，等於沒有限制任何東西。
// 計數表算的是**日期**，所以下面這幾條釘的都是「跨場次、跨模式還記得」這件事。

const TODAY = '2026-09-05';

test('同一天累加，不同天、不同模式各算各的', () => {
  let a = addActivity({}, 'vocabulary', TODAY);
  a = addActivity(a, 'vocabulary', TODAY);
  a = addActivity(a, 'vocabulary', '2026-09-04');
  a = addActivity(a, 'listening', TODAY, 6);

  assert.equal(activityCount(a, 'vocabulary', TODAY), 2);
  assert.equal(activityCount(a, 'vocabulary', '2026-09-04'), 1);
  assert.equal(activityCount(a, 'listening', TODAY), 6);
  assert.equal(activityCount(a, 'translation', TODAY), 0);
});

test('addActivity 不改到原本的計數表（畫面拿著舊的那份在算）', () => {
  const before = { vocabulary: { [TODAY]: 1 } };
  const after = addActivity(before, 'vocabulary', TODAY);
  // 原本那份一個字都不能動
  assert.equal(before.vocabulary[TODAY], 1);
  // 讀出來要用 activityCount ——「一天一格」之後裡面是 { slot: n } 而不是數字
  assert.equal(activityCount(after, 'vocabulary', TODAY), 2);
});

test('每台裝置只加自己那一格，別台的一個都不碰', () => {
  // 這是跨裝置合併能夠冪等的全部原因（見 lib/merge.js）
  const before = { vocabulary: { [TODAY]: { 'dev-other': 5 } } };
  const after = addActivity(before, 'vocabulary', TODAY, 2, { slot: 'dev-me' });

  assert.deepEqual(after.vocabulary[TODAY], { 'dev-other': 5, 'dev-me': 2 });
  assert.equal(activityCount(after, 'vocabulary', TODAY), 7, '讀出來要是所有格子的總和');
});

test('舊形狀（一天一個數字）加一次之後攤成 legacy 格 + 自己那一格', () => {
  // 直接蓋掉的話，改版之前練的那些就不見了
  const after = addActivity({ listening: { [TODAY]: 3 } }, 'listening', TODAY, 1, { slot: 'dev-me' });
  assert.deepEqual(after.listening[TODAY], { legacy: 3, 'dev-me': 1 });
  assert.equal(activityCount(after, 'listening', TODAY), 4);
});

test('activityCount 兩種形狀都讀得懂', () => {
  // 少了這道相容，改版之後使用者的連續天數會直接歸零
  assert.equal(activityCount({ vocabulary: { x: 7 } }, 'vocabulary', 'x'), 7);
  assert.equal(activityCount({ vocabulary: { x: { a: 3, b: 4 } } }, 'vocabulary', 'x'), 7);
});

test('不認得的模式與不合理的數量不會寫進去', () => {
  assert.deepEqual(addActivity({}, '亂寫', TODAY), {});
  assert.deepEqual(addActivity({}, 'vocabulary', ''), {});
  assert.deepEqual(addActivity({}, 'vocabulary', TODAY, 0), {});
  assert.deepEqual(addActivity({}, 'vocabulary', TODAY, -5), {});
  assert.deepEqual(addActivity({}, 'vocabulary', TODAY, NaN), {});
});

test('壞掉的值當成 0 —— 這是使用者改得到的 localStorage', () => {
  assert.equal(activityCount({ vocabulary: { x: 'abc' } }, 'vocabulary', 'x'), 0);
  assert.equal(activityCount({ vocabulary: { x: -5 } }, 'vocabulary', 'x'), 0);
  assert.equal(activityCount({ vocabulary: { x: 2.7 } }, 'vocabulary', 'x'), 2);
  assert.equal(activityCount(null, 'vocabulary', 'x'), 0);
});

test('只留最近幾天，而且留下來的是最新的那幾天', () => {
  let a = {};
  for (let i = 0; i < ACTIVITY_DAY_LIMIT + 5; i++) {
    a = addActivity(a, 'vocabulary', `2020-01-01+${String(i).padStart(4, '0')}`);
  }
  const keys = Object.keys(a.vocabulary);
  assert.equal(keys.length, ACTIVITY_DAY_LIMIT);
  assert.ok(keys.includes(`2020-01-01+${String(ACTIVITY_DAY_LIMIT + 4).padStart(4, '0')}`), '最新的一天被丟掉了');
  assert.ok(!keys.includes('2020-01-01+0000'), '最舊的一天沒有被丟掉');
});

test('一個模式的天數爆掉不會影響另一個模式', () => {
  let a = { listening: { '2020-01-01': 3 } };
  for (let i = 0; i < ACTIVITY_DAY_LIMIT + 5; i++) {
    a = addActivity(a, 'vocabulary', `2020-01-01+${String(i).padStart(4, '0')}`);
  }
  assert.equal(activityCount(a, 'listening', '2020-01-01'), 3);
});

test('今天全部模式的總和，給首頁用', () => {
  const a = { vocabulary: { [TODAY]: 20 }, listening: { [TODAY]: 6 }, dialogue: { '2026-09-04': 3 } };
  const today = activityToday(a, TODAY);
  assert.equal(today.total, 26);
  assert.equal(today.byMode.dialogue, 0);
  assert.deepEqual(Object.keys(today.byMode).sort(), [...MODE_IDS].sort());
});

test('連續天數用的是跟跟讀同一套算法', () => {
  const today = dayKey(new Date());
  const yesterday = dayKey(new Date(Date.now() - 864e5));
  const twoDaysAgo = dayKey(new Date(Date.now() - 2 * 864e5));

  const a = { vocabulary: { [today]: 5, [yesterday]: 20, [twoDaysAgo]: 20 } };
  assert.equal(streakFromDays(activityDays(a, 'vocabulary')), 3);

  // 今天還沒練不會馬上歸零 —— 從昨天開始往回算
  assert.equal(streakFromDays(activityDays({ vocabulary: { [yesterday]: 20, [twoDaysAgo]: 20 } }, 'vocabulary')), 2);

  // 練了 0 個的那天不算「有練」
  assert.equal(streakFromDays(activityDays({ vocabulary: { [today]: 0, [yesterday]: 3 } }, 'vocabulary')), 1);

  // 一個模式的連續天數不會被另一個模式撐起來
  assert.equal(streakFromDays(activityDays(a, 'listening')), 0);
});

test('沒有任何紀錄時連續天數是 0，而不是丟例外', () => {
  assert.equal(streakFromDays(activityDays({}, 'vocabulary')), 0);
  assert.equal(streakFromDays(activityDays(null, 'vocabulary')), 0);
});

// ─── 從舊資料生出計數表 ──────────────────────────────────────────────────
//
// 這段只跑一次，跑錯就是使用者的連續天數歸零 —— 沒有錯誤訊息，只有「咦我明明有練」。

test('舊的 vocabDays 直接搬成單字卡那一欄', () => {
  const a = buildActivity({ vocabDays: { '2026-09-04': 20, [TODAY]: 12 } });
  assert.equal(activityCount(a, 'vocabulary', '2026-09-04'), 20);
  assert.equal(activityCount(a, 'vocabulary', TODAY), 12);
});

test('跟讀從逐筆紀錄數出每天幾句', () => {
  const at = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();
  const a = buildActivity({
    history: [
      { at: at(0), score: 80 }, { at: at(0), score: 60 },
      { at: at(1), score: 90 },
      { at: at(1), score: null },        // 沒分數 = 沒真的練成一句，不算
      { at: 'x', score: 70 },            // 時間壞掉的那筆跳過
    ],
  });
  assert.equal(activityCount(a, 'shadowing', dayKey(new Date())), 2);
  assert.equal(activityCount(a, 'shadowing', dayKey(new Date(Date.now() - 864e5))), 1);
});

test('沒有舊資料時生出空的計數表，不會生出一堆空欄位', () => {
  assert.deepEqual(buildActivity({}), {});
  assert.deepEqual(buildActivity(), {});
  assert.deepEqual(buildActivity({ history: [] }), {});
});

test('每日進度的那句話：達成、還差幾個、沒設目標各講各的', () => {
  assert.match(todayNote(20, 20, 5, '個字'), /達成/);
  assert.match(todayNote(20, 20, 5, '個字'), /連續 5 天/);
  assert.match(todayNote(7, 20, 0, '個字'), /再 13 個字/);
  assert.match(todayNote(0, 20, 3, '個字'), /連續 3 天/);
  assert.match(todayNote(0, 20, 0, '個字'), /今天練 20 個字/);

  // 目標設 0（不限）不能寫成「0 / 0 達成」這種話
  assert.match(todayNote(12, 0, 2, '個字'), /練了 12 個字/);
  assert.match(todayNote(0, 0, 0, '個字'), /沒有設每日目標/);
});

test('鼓勵的話裡不出現威脅 —— 用罰的推人回來只會讓人不想打開', () => {
  const lines = [
    todayNote(0, 20, 7, '個字'), todayNote(5, 20, 7, '個字'),
    todayNote(20, 20, 7, '個字'), todayNote(0, 0, 0, '個字'),
  ];
  for (const line of lines) {
    assert.doesNotMatch(line, /斷|沒了|快要|失去/, line);
  }
});
