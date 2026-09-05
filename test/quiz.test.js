// 單字卡選擇題的出題規則。
//
// 這裡釘的核心只有一條：**一題只能有一個正確答案**。
// 干擾項如果跟答案同義（「完全地」有 7 個字），使用者選了一個「也對」的選項
// 卻被判錯 —— 那比不做選擇題還糟，因為他會以為自己記錯了。
// 真實資料裡這種撞號有 2,928 個字（29%），所以這條規則要拿真的字庫掃過。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  senses, firstSense, briefMeaning, canDistract, buildQuestion, pickType,
  QUIZ_TYPE_IDS, OPTION_COUNT, BRIEF_SENSES,
} from '../public/lib/quiz.js';

const DIR = path.join(import.meta.dirname, '..', 'content', 'vocabulary');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));

/** 依序回傳固定值的假亂數。用完之後一律回 0 —— sample() 有保底，不會卡住。 */
const fakeRandom = (values) => {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0);
};

// ─── 義項 ────────────────────────────────────────────────────────────────

test('義項會切開，領域標記會拿掉', () => {
  assert.deepEqual(
    [...senses('前提, 房屋連地基\n[化] 校正; 訂正')],
    ['前提', '房屋連地基', '校正', '訂正'],
  );
});

test('第一個義項就是題目上的那個中文', () => {
  assert.equal(firstSense('說, 講, 念, 說明'), '說');
  assert.equal(firstSense(''), '');
  assert.equal(firstSense(undefined), '');
});

test('釋義講短一點：前幾個義項，多的用省略號帶過', () => {
  assert.equal(briefMeaning('說, 講, 念, 說明'), '說、講、念…');
  assert.equal(briefMeaning('借, 借用'), '借、借用');
  assert.equal(briefMeaning('前提\n[化] 校正; 訂正', 2), '前提、校正…');
  // 一個都不留的話畫面上會是空的，所以 max 夾在 1 以上
  assert.equal(briefMeaning('說, 講, 念', 0), '說…');
  assert.equal(briefMeaning(''), '');
  assert.equal(briefMeaning(undefined), '');
});

// ─── 干擾項規則 ──────────────────────────────────────────────────────────

const CARD = { id: 1, word: 'show', pos: 'vt.', meaning_zh: '顯示, 表明, 展現' };

test('義項有任何重疊就不能當干擾項', () => {
  // indicate 也有「顯示」—— 放進同一題就會有兩個對的答案
  assert.equal(canDistract(CARD, { id: 2, word: 'indicate', pos: 'vt.', meaning_zh: '指出, 顯示' }), false);
  // 完全不重疊才可以
  assert.equal(canDistract(CARD, { id: 3, word: 'borrow', pos: 'vt.', meaning_zh: '借, 借用' }), true);
});

test('詞性不同不放在一起（不然光看詞性就刪掉一半選項）', () => {
  assert.equal(canDistract(CARD, { id: 4, word: 'table', pos: 'n.', meaning_zh: '桌子' }), false);
  // 有一邊沒詞性就不比 —— ECDICT 近兩成的字沒有詞性
  assert.equal(canDistract(CARD, { id: 5, word: 'table', pos: '', meaning_zh: '桌子' }), true);
});

test('自己不能當自己的干擾項（同 id 或同一個字）', () => {
  assert.equal(canDistract(CARD, CARD), false);
  assert.equal(canDistract(CARD, { id: 99, word: 'show', pos: 'vt.', meaning_zh: '別的意思' }), false);
  assert.equal(canDistract(CARD, null), false);
});

// ─── 出題 ────────────────────────────────────────────────────────────────

const POOL = [
  CARD,
  { id: 2, word: 'indicate', pos: 'vt.', meaning_zh: '指出, 顯示' },   // 同義，要被排除
  { id: 3, word: 'borrow', pos: 'vt.', meaning_zh: '借, 借用' },
  { id: 4, word: 'deliver', pos: 'vt.', meaning_zh: '遞送, 交付' },
  { id: 5, word: 'squeeze', pos: 'vt.', meaning_zh: '擠, 壓榨' },
  { id: 6, word: 'table', pos: 'n.', meaning_zh: '桌子' },             // 詞性不同
];

test('中→英：題目是中文，選項是英文，正確答案剛好一個', () => {
  const q = buildQuestion(CARD, POOL, { direction: 'zh2en', random: fakeRandom([0.1, 0.5, 0.9, 0.3]) });

  assert.equal(q.prompt, '顯示');
  assert.equal(q.options.length, OPTION_COUNT);
  assert.equal(q.options.filter((o) => o.correct).length, 1);
  assert.equal(q.options.find((o) => o.correct).text, 'show');
  assert.ok(q.options.every((o) => typeof o.text === 'string' && o.text));
});

test('英→中：題目是英文，選項是中文', () => {
  const q = buildQuestion(CARD, POOL, { direction: 'en2zh', random: fakeRandom([0.2, 0.6, 0.4]) });

  assert.equal(q.prompt, 'show');
  assert.equal(q.options.find((o) => o.correct).text, '顯示');
  assert.equal(q.options.length, OPTION_COUNT);
});

test('同義字與不同詞性的字不會出現在選項裡', () => {
  for (let i = 0; i < 30; i++) {
    const q = buildQuestion(CARD, POOL, { direction: 'zh2en' });
    const words = q.options.map((o) => o.text);
    assert.ok(!words.includes('indicate'), `同義字跑進選項：${words.join('、')}`);
    assert.ok(!words.includes('table'), `詞性不同的字跑進選項：${words.join('、')}`);
  }
});

test('選項文字不重複 —— 兩個不同的字可能有一樣的第一個義項', () => {
  const pool = [
    { id: 1, word: 'happy', pos: 'adj.', meaning_zh: '快樂的' },
    { id: 2, word: 'glad', pos: 'adj.', meaning_zh: '高興的' },
    { id: 3, word: 'joyful', pos: 'adj.', meaning_zh: '高興的' },   // 跟 glad 一樣
    { id: 4, word: 'tired', pos: 'adj.', meaning_zh: '疲倦的' },
    { id: 5, word: 'brave', pos: 'adj.', meaning_zh: '勇敢的' },
  ];
  const q = buildQuestion(pool[0], pool, { direction: 'en2zh' });
  const texts = q.options.map((o) => o.text);
  assert.equal(new Set(texts).size, texts.length, texts.join('、'));
});

// ─── 選項要帶著自己那個字的資料 ──────────────────────────────────────────
//
// 答完之後畫面會列出另外三個選項的字、音標與意思（順便可以聽）。
// 那些資料是出題的時候一起抓下來的 —— 呼叫端手上只有 question，
// 少一個欄位的症狀就是那一段整片空白。

const RICH = [
  { id: 1, word: 'show', pos: 'vt.', ipa: 'ʃəʊ', meaning_zh: '顯示, 表明, 展現' },
  { id: 2, word: 'borrow', pos: 'vt.', ipa: 'ˈbɒrəʊ', meaning_zh: '借, 借用' },
  { id: 3, word: 'deliver', pos: 'vt.', ipa: 'dɪˈlɪvə', meaning_zh: '遞送, 交付' },
  { id: 4, word: 'squeeze', pos: 'vt.', ipa: 'skwiːz', meaning_zh: '擠, 壓榨' },
  { id: 5, word: 'punish', pos: 'vt.', ipa: 'ˈpʌnɪʃ', meaning_zh: '懲罰, 處罰' },
];

for (const direction of ['zh2en', 'en2zh']) {
  test(`${direction}：每個選項都帶著字、音標、詞性與簡短釋義`, () => {
    const q = buildQuestion(RICH[0], RICH, { direction });
    for (const option of q.options) {
      const source = RICH.find((c) => c.id === option.id);
      assert.equal(option.word, source.word);
      assert.equal(option.ipa, source.ipa);
      assert.equal(option.pos, source.pos);
      assert.equal(option.meaning, briefMeaning(source.meaning_zh));
    }
  });
}

test('缺欄位的字不會讓選項帶著 undefined 出去', () => {
  const pool = [
    { id: 1, word: 'show', meaning_zh: '顯示' },
    { id: 2, word: 'borrow', meaning_zh: '借' },
    { id: 3, word: 'deliver', meaning_zh: '遞送' },
    { id: 4, word: 'squeeze', meaning_zh: '擠' },
  ];
  const q = buildQuestion(pool[0], pool, { direction: 'zh2en' });
  for (const option of q.options) {
    assert.equal(typeof option.ipa, 'string');
    assert.equal(typeof option.pos, 'string');
    assert.ok(option.word, '沒有字的話那一列連要唸什麼都不知道');
  }
});

test('湊不到足夠的干擾項就回 null（呼叫端要退回翻卡）', () => {
  assert.equal(buildQuestion(CARD, [CARD], { direction: 'zh2en' }), null);
  assert.equal(buildQuestion(CARD, POOL.slice(0, 3), { direction: 'zh2en' }), null);
  assert.equal(buildQuestion(null, POOL, { direction: 'zh2en' }), null);
  // 沒有中文釋義的字出不了「英→中」的題
  assert.equal(buildQuestion({ id: 9, word: 'x', meaning_zh: '' }, POOL, { direction: 'en2zh' }), null);
});

test('詞性湊不滿時先放掉詞性，但義項那條永遠不放', () => {
  const pool = [
    CARD,
    { id: 2, word: 'indicate', pos: 'vt.', meaning_zh: '顯示' },  // 同義，永遠不能用
    { id: 3, word: 'table', pos: 'n.', meaning_zh: '桌子' },
    { id: 4, word: 'quickly', pos: 'adv.', meaning_zh: '很快地' },
    { id: 5, word: 'blue', pos: 'adj.', meaning_zh: '藍色的' },
  ];
  const q = buildQuestion(CARD, pool, { direction: 'zh2en' });
  assert.ok(q, '放寬詞性之後應該出得了題');
  assert.ok(!q.options.some((o) => o.text === 'indicate'));
});

test('壞掉的亂數不會讓出題卡住或少一個選項', () => {
  for (const random of [() => 0, () => 0.999999, () => NaN, () => -1]) {
    const q = buildQuestion(CARD, POOL, { direction: 'zh2en', random });
    assert.equal(q.options.length, OPTION_COUNT);
    assert.equal(q.options.filter((o) => o.correct).length, 1);
  }
});

// ─── 拿真實資料掃一遍 ────────────────────────────────────────────────────

test('六個分級都出得了題，而且沒有一題有兩個正確答案', () => {
  for (const tier of [1, 2, 3, 4, 5, 6]) {
    const cards = load(`tier-${tier}.json`);
    // 每一級抽 40 個字、兩個方向都出一次
    for (let i = 0; i < 40; i++) {
      const card = cards[Math.floor((i / 40) * cards.length)];
      for (const direction of ['zh2en', 'en2zh']) {
        const q = buildQuestion(card, cards, { direction });
        assert.ok(q, `tier-${tier} 的「${card.word}」出不了 ${direction} 的題`);
        assert.equal(q.options.length, OPTION_COUNT);
        assert.equal(q.options.filter((o) => o.correct).length, 1);

        // 每個選項都講得出「這是哪個字、什麼意思」—— 答完之後那一段要用
        for (const option of q.options) {
          assert.ok(option.word, `tier-${tier}：選項 ${option.id} 沒有字`);
          assert.ok(option.meaning, `tier-${tier}：「${option.word}」沒有釋義`);
          assert.ok(senses(option.meaning).size <= BRIEF_SENSES,
            `tier-${tier}：「${option.word}」的釋義沒有截短 → ${option.meaning}`);
        }

        // 沒有任何一個干擾項跟答案共用義項
        const answerSenses = senses(card.meaning_zh);
        for (const option of q.options.filter((o) => !o.correct)) {
          const other = cards.find((c) => c.id === option.id);
          for (const sense of senses(other.meaning_zh)) {
            assert.ok(!answerSenses.has(sense),
              `tier-${tier}：「${card.word}」與「${other.word}」都有「${sense}」`);
          }
        }
      }
    }
  }
});

// ─── 題型可以複選 ────────────────────────────────────────────────────────

test('勾了哪幾種就只出哪幾種', () => {
  for (let i = 0; i < 50; i++) {
    assert.ok(['zh2en', 'en2zh'].includes(pickType(['zh2en', 'en2zh'])));
  }
  assert.equal(pickType(['en2zh']), 'en2zh');
});

test('一個都沒勾（或設定壞掉）就退回翻卡，不是整個不能用', () => {
  assert.equal(pickType([]), 'flip');
  assert.equal(pickType(null), 'flip');
  assert.equal(pickType(['亂寫的']), 'flip');
  assert.ok(QUIZ_TYPE_IDS.includes(pickType(['亂寫的', 'en2zh'])));
});

test('亂數在邊界值也不會回 undefined', () => {
  for (const random of [() => 0, () => 0.9999999, () => 1, () => NaN]) {
    assert.ok(QUIZ_TYPE_IDS.includes(pickType(['zh2en', 'en2zh'], random)));
  }
});
