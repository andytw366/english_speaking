// content/translation.json 的資料檢查。不需要網路與金鑰。
//
// 為什麼值得測：這份資料現在有 2,000 多題，其中絕大多數是腳本從 Tatoeba 匯入的 ——
// 而資料錯了不會炸，只會安靜地讓某一題永遠判錯。最容易發生的兩種：
//   1. `accept` 裡的某個說法自己過不了 `grade()`（使用者照著「其他說法」寫卻拿到 ❌）
//   2. 簡繁轉換的錯字（「髮現」）出現在**題目**上，使用者第一眼就看到
// 兩種都只有整份掃過才抓得到。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { grade, normalize, tokens } from '../public/lib/grade.js';
import { CATEGORY_LABEL, DIFFICULTY_LABEL } from '../public/lib/labels.js';
import { QUOTA, keywordsFor, select } from '../scripts/import-translation.mjs';

const items = JSON.parse(readFileSync(new URL('../content/translation.json', import.meta.url)));
const clozes = items.filter((x) => x.type === 'cloze');

test('每一題都有必要欄位，型別也對', () => {
  for (const x of items) {
    assert.equal(typeof x.id, 'number', `id 有問題：${JSON.stringify(x).slice(0, 120)}`);
    assert.ok(['cloze', 'sentence'].includes(x.type), `未知的題型：${x.type}（id ${x.id}）`);
    assert.ok(typeof x.zh === 'string' && x.zh.trim(), `zh 是空的：${x.id}`);
    assert.ok(typeof x.answer === 'string' && x.answer.trim(), `answer 是空的：${x.id}`);
    assert.ok(Array.isArray(x.accept) && x.accept.length > 0, `accept 不是非空陣列：${x.id}`);
  }
});

test('id 沒有重複', () => {
  // 重複的 id 在中翻英不會讓進度對錯（進度只算次數），但「這題我剛做過」
  // 的去重是用 id 做的，重複會讓同一題連續出現兩次
  const ids = items.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('category 與 difficulty 都有對應的中文標籤', () => {
  for (const x of items) {
    assert.ok(CATEGORY_LABEL[x.category], `沒有中文標籤的情境：${x.category}（id ${x.id}）`);
    assert.ok(DIFFICULTY_LABEL[x.difficulty], `沒有中文標籤的難度：${x.difficulty}（id ${x.id}）`);
  }
});

test('answer 一定排在 accept 的第一個', () => {
  // 前端的「參考答案」與逐字對照都用 answer，而「其他說法」用的是 accept.slice(1)。
  // answer 不在第一個的話，它會被自己列進「其他說法」裡
  for (const x of items) {
    assert.equal(x.accept[0], x.answer, `accept[0] 不是 answer：${x.id}`);
  }
});

test('accept 裡沒有重複的說法', () => {
  // 用 grade.js 自己的 normalize()：標點不同（`weekend?` / `weekend`）在批改時
  // 是同一個答案，列進「其他說法」只會讓人以為自己漏打了問號。
  // 但連字號**有**差別（normalize 不去連字號），`trade-offs` 與 `tradeoffs`
  // 是兩個真的要分別接受的字串，不算重複。
  for (const x of items) {
    const norm = x.accept.map(normalize);
    assert.equal(new Set(norm).size, norm.length, `accept 有重複：${x.id} ${JSON.stringify(x.accept)}`);
  }
});

test('accept 裡的每一種說法，自己送進 grade() 都要判成完全正確', () => {
  // 這是整份資料最重要的一條。使用者看得到「其他說法」，照著寫卻拿到 ❌
  // 是最傷的一種 bug —— 而且完全不會有錯誤訊息，只會讓人以為自己寫錯了
  for (const x of items) {
    for (const a of x.accept) {
      const { level } = grade({ ...x, strict: x.type === 'cloze' }, a);
      assert.equal(level, 'exact', `accept 判不到 exact：id ${x.id}「${a}」`);
    }
  }
});

/** keyword 的每個字都出現在這句話裡？用的是 grade.js 真正批改時的切詞方式。 */
function covers(text, keyword) {
  const got = new Set(tokens(text));
  return tokens(keyword).every((t) => got.has(t));
}

test('每一個 keyword 都出現在 answer 裡', () => {
  // 這條抓的是「打錯字或用了子字串」——「complicate」不是「overcomplicate」的 token，
  // 所以那一題永遠判不到「意思對了」，只會在畫面上說「少了關鍵用字：complicate」，
  // 看起來像使用者漏字。這種錯全部題目都不該有。
  for (const x of items) {
    for (const kw of x.keywords ?? []) {
      assert.ok(covers(x.answer, kw), `keyword「${kw}」不在 answer 裡：id ${x.id}「${x.answer}」`);
    }
  }
});

test('匯入的題目：keywords 每一種說法都涵蓋得到', () => {
  // keywords 全中才算「意思對了」。某個 keyword 只出現在其中一種說法裡的話，
  // 使用者用另一種同樣正確的說法作答就會被判成「再想想」——
  // 而那個說法就列在畫面上的「其他說法」裡。
  //
  // 這條**只套在匯入的題目**上，因為那是 `keywordsFor()` 用交集算出來的、
  // 保證成立的性質；手寫的 118 題有 93 題不符合（keywords 是照 answer 挑的，
  // 而 accept[1] 常常是很不一樣的講法），那是既有的資料債，記在 TODO.md 裡。
  const imported = items.filter((x) => x.source === 'tatoeba');
  assert.ok(imported.length > 1000, '匯入的題目太少，這條測試等於沒測到');

  for (const x of imported) {
    for (const a of x.accept) {
      for (const kw of x.keywords ?? []) {
        assert.ok(covers(a, kw), `keyword「${kw}」不在這個說法裡：id ${x.id}「${a}」`);
      }
    }
  }
});

test('匯入的題目都有夠多的 keywords 可以判「意思對了」', () => {
  // 一個都沒有的話，隨便寫什麼都會被判成「意思對了」
  for (const x of items.filter((y) => y.source === 'tatoeba')) {
    assert.ok(x.keywords.length >= 2, `keywords 太少：id ${x.id} ${JSON.stringify(x.keywords)}`);
  }
});

test('填空題的 sentence 一定有一個 ___', () => {
  for (const x of clozes) {
    assert.ok(typeof x.sentence === 'string', `填空題沒有 sentence：${x.id}`);
    assert.equal(x.sentence.split('___').length - 1, 1, `___ 的數量不對：${x.id}`);
  }
});

test('題目的中文沒有簡繁轉換的錯字', () => {
  // OpenCC 的一對多（发 → 發／髮）轉錯時，畫面上就是個錯字。
  // 撞到新的型樣時補進 scripts/corpus.js 的 FIXES，再把型樣加到這裡
  const WRONG = [/髮明/, /髮現/, /髮生/, /髮展/, /髮出/, /頭發/, /著涼了嗎/];
  for (const x of items) {
    for (const pattern of WRONG) {
      assert.ok(!pattern.test(x.zh), `中文有錯字（${pattern}）：id ${x.id}「${x.zh}」`);
    }
  }
});

test('題目的中文裡沒有殘留的簡體字', () => {
  // 抽驗幾個最常見的。整份掃簡體字要一張大表，而這幾個只要出現就代表
  // toTraditional() 那一段沒跑到（例如新的匯入路徑忘了呼叫）
  const SIMPLIFIED = /[这么们个说没问题话样国还买东车间医觉]/;
  const bad = items.filter((x) => SIMPLIFIED.test(x.zh));
  assert.equal(bad.length, 0, `有簡體字的題目：${bad.slice(0, 3).map((x) => `${x.id}「${x.zh}」`).join('、')}`);
});

test('每個情境都有足夠的題目可以出', () => {
  // 練習範圍可以只選一個情境。某個情境只有幾題的話，選了它就會一直重複
  const MIN_PER_CATEGORY = 40;
  const counts = new Map();
  for (const x of items) counts.set(x.category, (counts.get(x.category) ?? 0) + 1);
  for (const [category, n] of counts) {
    assert.ok(n >= MIN_PER_CATEGORY, `${category} 只有 ${n} 題，太少`);
  }
});

test('keywordsFor 只留每一種說法都有的實詞', () => {
  const freq = { all: new Map([['salt', 10], ['pass', 50], ['please', 200]]) };
  const kws = keywordsFor(
    ['Could you pass the salt, please?', 'Would you pass me the salt?'],
    freq
  );
  assert.ok(kws.includes('salt'));
  assert.ok(kws.includes('pass'));
  // please 只出現在第一種說法裡 —— 收進去的話，用第二種說法作答就會被判錯
  assert.ok(!kws.includes('please'));
  // 冠詞與代名詞是虛詞，不能佔掉 keywords 的名額
  assert.ok(!kws.includes('the'));
  assert.ok(!kws.includes('you'));
});

test('keywordsFor 排除只出現在部分說法裡的字之後可能一個都不剩', () => {
  // 這種題目匯入時就會被丟掉（MIN_KEYWORDS）。這裡釘住「回空陣列」而不是報錯 ——
  // 丟掉的判斷在呼叫端，這支函式只負責算交集
  const freq = { all: new Map() };
  assert.deepEqual(keywordsFor(['I am going home.', 'Let us leave now.'], freq), []);
});

test('select 的配額從既有題數起算，不是從 0', () => {
  // import-sentences.mjs 踩過這個坑：從 0 起算的話，題庫已經滿了再跑一次
  // 照樣加滿一輪，總量安靜地變成兩倍，而且因為有去重所以看不出是重複
  const existing = Array.from({ length: QUOTA }, (_, i) => ({
    id: i + 1, category: 'work', difficulty: 'easy', zh: `既有${i}`, answer: `existing answer number ${i}`,
  }));
  const candidates = Array.from({ length: 10 }, (_, i) => ({
    category: 'work', difficulty: 'easy', zh: `新的${i}`, answer: `brand new answer number ${i}`, accept: ['x'],
  }));
  assert.deepEqual(select(candidates, existing), []);
});

test('select 不會收到 zh 或 answer 跟既有題目重複的', () => {
  const existing = [
    { id: 1, category: 'work', difficulty: 'easy', zh: '我明天有空。', answer: 'I am free tomorrow.' },
  ];
  const candidates = [
    { category: 'work', difficulty: 'easy', zh: '我明天有空。', answer: 'I have time tomorrow.', accept: ['x'] },
    { category: 'work', difficulty: 'easy', zh: '你明天有空嗎？', answer: 'I am free tomorrow.', accept: ['x'] },
    { category: 'work', difficulty: 'easy', zh: '我們下週見。', answer: 'See you next week.', accept: ['x'] },
  ];
  const picked = select(candidates, existing);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].zh, '我們下週見。');
});
