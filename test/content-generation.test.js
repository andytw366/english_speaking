// 題庫生成的守門員（scripts/generate-content.mjs），以及聽力與情境對話這兩份資料。
//
// 為什麼這一份要有：這兩個模式的內容是**用模型生出來的**，而生出來的東西壞掉
// 通常不會有任何錯誤訊息 —— 一題只有三個選項、兩個選項一模一樣、解析是把英文
// 原句抄一遍、對話的 keywords 根本不在參考答案裡（那一題就永遠判不到「意思對了」）。
// 真的呼叫模型要金鑰、要配額、回來的東西每次還不一樣，所以驗收規則必須自己測。
//
// 三段：
//   CATEGORIES  生成器認得的情境要跟 App 一樣 —— 少了就永遠生不出那個情境
//   sift()      壞資料要被退掉、重複的要擋掉（含同一批裡的重複）
//   現有資料    content/listening.json 與 dialogues.json 要過得了同一套規則

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  CATEGORIES, DIFFICULTIES, TYPES, firstWords, mergeIntoExisting, norm, sift,
} from '../scripts/generate-content.mjs';
import { CATEGORY_LABEL, DIFFICULTY_ORDER } from '../public/lib/labels.js';
import { grade, tokens } from '../public/lib/grade.js';

const DIR = path.join(import.meta.dirname, '..', 'content');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));

// ─── 生成器認得的情境 ────────────────────────────────────────────────────

test('生成器的情境清單跟 App 完全一樣', () => {
  // **真的踩過**：這裡原本自己寫死四個（work / daily / travel / interview），
  // 結果聽力與情境對話永遠生不出餐飲、購物、健康、學習 —— 那四個情境各 0 組，
  // 而設定頁那八顆按鈕照樣點得下去（點了會靜靜退回全部題目）。
  assert.deepEqual(CATEGORIES, Object.keys(CATEGORY_LABEL));
  assert.deepEqual(DIFFICULTIES, DIFFICULTY_ORDER);
});

test('schema 的 enum 跟那份清單是同一份', () => {
  // schema 是送給模型的，validate 是收回來時擋的。兩邊分家的話，
  // 模型會照舊的 enum 生，然後每一筆都被 validate 退掉 —— 燒了配額卻一筆都沒收下
  for (const [name, spec] of Object.entries(TYPES)) {
    const props = spec.schema.properties.items.items.properties;
    assert.deepEqual(props.category.enum, CATEGORIES, name);
    assert.deepEqual(props.difficulty.enum, DIFFICULTIES, name);
  }
});

// ─── 正規化與近似重複 ────────────────────────────────────────────────────

test('正規化把大小寫、空白與標點的差別吃掉', () => {
  assert.equal(norm('Checking  IN, at the airport!'), norm('checking in at the airport'));
  assert.equal(firstWords('One two three four five', 3), 'one two three');
});

// ─── sift()：壞資料要退掉 ────────────────────────────────────────────────

const listeningItem = (patch = {}) => ({
  title: 'Ordering at a café',
  category: 'food',
  difficulty: 'easy',
  transcript: 'Hi, welcome in. We stop serving breakfast at eleven, so if you want the ' +
    'pancakes you should order now. Otherwise the lunch menu starts at eleven fifteen ' +
    'and the soup today is tomato with a little basil on top.',
  questions: [
    {
      question: 'When does breakfast stop?',
      options: ['At eleven', 'At noon', 'At ten', 'At one'],
      answer: 0,
      explain_zh: '獨白說 stop serving breakfast at eleven，所以是十一點。',
    },
    {
      question: 'What is today\'s soup?',
      options: ['Tomato', 'Corn', 'Onion', 'Chicken'],
      answer: 0,
      explain_zh: '最後一句說 the soup today is tomato，番茄湯。',
    },
  ],
  ...patch,
});

/** 只改第一題的某個欄位 —— 大部分退件情境都是某一題壞掉，不是整組壞掉。 */
const withQ1 = (patch) => {
  const item = listeningItem();
  item.questions[0] = { ...item.questions[0], ...patch };
  return item;
};

test('乾淨的聽力題收得下來', () => {
  const { accepted, rejected } = sift(TYPES.listening, [listeningItem()], new Set());
  assert.equal(rejected.length, 0, JSON.stringify(rejected[0]?.problem));
  assert.equal(accepted.length, 1);
});

test('聽力：壞掉的地方要講得出是哪裡壞', () => {
  const cases = [
    [listeningItem({ category: 'nope' }), /category/],
    [listeningItem({ difficulty: 'trivial' }), /difficulty/],
    [listeningItem({ title: '  ' }), /title/],
    [listeningItem({ transcript: 'Too short.' }), /太短/],
    [listeningItem({ transcript: '這段逐字稿是中文的，'.repeat(6) }), /太短|含中文/],
    [listeningItem({ questions: [listeningItem().questions[0]] }), /題數/],
    [withQ1({ options: ['a', 'b', 'c'] }), /選項不是 4 個/],
    [withQ1({ options: ['a', 'a', 'b', 'c'] }), /選項重複/],
    [withQ1({ answer: 4 }), /answer 超出範圍/],
    [withQ1({ answer: 1.5 }), /answer 超出範圍/],
    [withQ1({ question: '什麼時候停止供應早餐？' }), /題目含中文/],
    [withQ1({ options: ['十一點', 'b', 'c', 'd'] }), /選項含中文/],
    // 解析抄一遍英文原句等於沒有解析
    [withQ1({ explain_zh: 'They stop serving breakfast at eleven.' }), /解析/],
  ];

  for (const [item, expected] of cases) {
    const problem = TYPES.listening.validate(item);
    assert.match(String(problem), expected, JSON.stringify(item).slice(0, 80));
  }
});

const dialogueItem = (patch = {}) => ({
  title: '在藥局買感冒藥',
  category: 'health',
  difficulty: 'easy',
  setting_zh: '你感冒了，到藥局請藥師推薦成藥。',
  your_role_zh: '你',
  partner_role_zh: '藥師',
  turns: [
    { speaker: 'partner', en: 'Hi there, what can I help you with today?' },
    {
      speaker: 'you',
      intent_zh: '說你喉嚨痛了兩天，想找不會讓人昏昏欲睡的藥。',
      answer: 'My throat has been sore for two days and I need something non-drowsy.',
      accept: [
        'My throat has been sore for two days and I need something non-drowsy.',
        'I have had a sore throat for two days. Do you have anything non-drowsy?',
      ],
      keywords: ['sore', 'non-drowsy'],
      note_zh: 'non-drowsy 是藥盒上的固定說法，比 not sleepy 自然。',
    },
    { speaker: 'partner', en: 'This one should be fine. Take one tablet every eight hours.' },
    {
      speaker: 'you',
      intent_zh: '確認可不可以跟你在吃的維他命一起吃。',
      answer: 'Can I take this with my vitamins?',
      accept: ['Can I take this with my vitamins?', 'Is it okay to take with vitamins?'],
      keywords: ['take', 'vitamins'],
      note_zh: '問可不可以一起吃用 take with，不要用 eat together。',
    },
  ],
  ...patch,
});

test('乾淨的情境對話收得下來', () => {
  const { accepted, rejected } = sift(TYPES.dialogue, [dialogueItem()], new Set());
  assert.equal(rejected.length, 0, JSON.stringify(rejected[0]?.problem));
  assert.equal(accepted.length, 1);
});

test('情境對話：keywords 一定要真的在參考答案裡', () => {
  // 這是中翻英那邊踩過的同一個坑：keywords 列了一個 answer 裡沒有的字，
  // 那一題就**永遠**判不到「意思對了」，而畫面上只會說「再想想」
  const item = dialogueItem();
  item.turns[1].keywords = ['sore', 'drowsy-free'];
  assert.match(String(TYPES.dialogue.validate(item)), /keywords 不在 answer 裡/);
});

test('情境對話：accept 一定要含 answer、你的台詞至少兩句', () => {
  const noAnswer = dialogueItem();
  noAnswer.turns[1].accept = ['Something else entirely.'];
  assert.match(String(TYPES.dialogue.validate(noAnswer)), /accept 未含 answer/);

  // 四個回合、但只有一句是你的 —— 回合數的檢查過得了，台詞數過不了
  const onlyOne = dialogueItem();
  onlyOne.turns = [
    onlyOne.turns[0], onlyOne.turns[1], onlyOne.turns[2],
    { speaker: 'partner', en: 'Anything else I can get for you today?' },
  ];
  assert.match(String(TYPES.dialogue.validate(onlyOne)), /使用者台詞只有 1 句/);

  const badSpeaker = dialogueItem();
  badSpeaker.turns[0] = { speaker: 'narrator', en: 'Once upon a time.' };
  assert.match(String(TYPES.dialogue.validate(badSpeaker)), /speaker 不合法/);
});

test('情境對話：中文欄位是中文、英文欄位不能有中文', () => {
  const enIntent = dialogueItem();
  enIntent.turns[1].intent_zh = 'Say your throat hurts.';
  assert.match(String(TYPES.dialogue.validate(enIntent)), /intent_zh/);

  const zhAnswer = dialogueItem();
  zhAnswer.turns[1].answer = '我的喉嚨痛了兩天。';
  assert.match(String(TYPES.dialogue.validate(zhAnswer)), /answer 有問題/);

  const zhPartner = dialogueItem();
  zhPartner.turns[0].en = '你今天想找什麼？';
  assert.match(String(TYPES.dialogue.validate(zhPartner)), /含中文/);
});

// ─── sift()：重複要擋掉 ──────────────────────────────────────────────────

test('同一個標題進不來第二次', () => {
  const seen = new Set(TYPES.listening.dedupeKeys(listeningItem()));
  const { accepted, rejected } = sift(TYPES.listening, [listeningItem()], seen);
  assert.equal(accepted.length, 0);
  assert.match(rejected[0].problem, /重複/);
});

test('對話：換個標題但情境一樣算重複，開場白一樣不算', () => {
  // 開場白是公式化的：現有資料裡「寄包裹」與「郵局寄掛號」都以
  // "Next please. What can I do for you?" 開頭，那是兩段不同的對話。
  // 拿它當鍵的話會把好內容擋在門外
  const seen = new Set(TYPES.dialogue.dedupeKeys(dialogueItem()));

  const sameSetting = dialogueItem({ title: '另一個標題' });
  assert.match(sift(TYPES.dialogue, [sameSetting], new Set(seen)).rejected[0].problem, /重複/);

  const sameOpener = dialogueItem({
    title: '在藥局領處方藥',
    setting_zh: '你拿著醫生開的處方到藥局領藥，順便問劑量。',
  });
  assert.equal(sift(TYPES.dialogue, [sameOpener], new Set(seen)).accepted.length, 1);
});

test('換個標題但逐字稿一樣，也算重複', () => {
  // 重跑幾批之後，模型很容易再寫出幾乎一樣的獨白（「機場報到」寫十次都很像），
  // 只看標題的話它換個名字就進來了
  const seen = new Set(TYPES.listening.dedupeKeys(listeningItem()));
  const twin = listeningItem({ title: 'A different title entirely' });
  const { accepted, rejected } = sift(TYPES.listening, [twin], seen);
  assert.equal(accepted.length, 0);
  assert.match(rejected[0].problem, /重複/);
});

test('同一批裡的重複也擋得掉', () => {
  // 模型在同一次回應裡寫出兩段一樣的東西是常態
  const { accepted, rejected } = sift(
    TYPES.listening,
    [listeningItem(), listeningItem({ title: 'Another name' })],
    new Set(),
  );
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
});

test('只差標點與大小寫的標題算同一個', () => {
  const seen = new Set(TYPES.listening.dedupeKeys(listeningItem()));
  const shouty = listeningItem({
    title: 'ORDERING AT A CAFÉ!!',
    transcript: 'Completely different content here, long enough to pass the word count check, ' +
      'talking about a bus that leaves from the north side of the station every twenty minutes.',
  });
  assert.match(sift(TYPES.listening, [shouty], seen).rejected[0].problem, /重複/);
});

test('還差幾筆就只收幾筆', () => {
  const items = [
    listeningItem(),
    listeningItem({ title: 'Second one', transcript: listeningItem().transcript.replace('pancakes', 'waffles') }),
  ];
  // 第二筆的逐字稿只換一個字，前 12 個字一樣 —— 所以它本來就會被當成重複。
  // 這裡驗的是 limit：給 0 的話連第一筆都不收
  assert.equal(sift(TYPES.listening, items, new Set(), 0).accepted.length, 0);
  assert.equal(sift(TYPES.listening, items, new Set(), 1).accepted.length, 1);
});

// ─── 現有資料要過得了同一套規則 ──────────────────────────────────────────

for (const [kind, spec] of [['listening', TYPES.listening], ['dialogue', TYPES.dialogue]]) {
  test(`content/${spec.file} 每一筆都過得了生成器的驗證`, () => {
    // 生成器的規則與已經上線的資料**必須是同一套**。分家的話有兩種壞法：
    // 規則變鬆（下一批生成寫進來的東西比現有的差），或規則變嚴到連現有資料
    // 都不合格（那批東西早就在使用者眼前了，只有測試會告訴你）
    const data = load(spec.file);
    const bad = data.map((x) => [x.id, spec.validate(x)]).filter(([, p]) => p);
    assert.deepEqual(bad, [], `${kind}：${bad.slice(0, 3).map(([id, p]) => `#${id} ${p}`).join('；')}`);
  });

  test(`content/${spec.file} 的 id 不重複、dedupe 鍵不重複`, () => {
    const data = load(spec.file);
    const ids = data.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, 'id 重複');

    const keys = data.flatMap(spec.dedupeKeys);
    const dups = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepEqual(dups, [], `重複的鍵：${dups.slice(0, 3).join('、')}`);
  });
}

test('聽力：一組 2～6 題，而且題數跟畫面上的計數對得起來', () => {
  // 聽力的「今天練了幾組」算的是組數（`listening.js` 的 counted）——
  // 一組只有一題的話，那一組會在按一次之後就結束，進度跳得莫名其妙
  const data = load('listening.json');
  for (const item of data) {
    assert.ok(item.questions.length >= 2 && item.questions.length <= 6,
      `#${item.id} 有 ${item.questions.length} 題`);
  }
});

test('情境對話：每一段都有 2～5 句你的台詞', () => {
  // 太少的話一段對話幾乎不用開口；太多的話一段練不完（每一句都要錄音比對）
  const data = load('dialogues.json');
  for (const item of data) {
    const yours = item.turns.filter((t) => t.speaker === 'you').length;
    assert.ok(yours >= 2 && yours <= 5, `#${item.id} 有 ${yours} 句`);
  }
});

test('聽力與情境對話涵蓋的情境數不能變少', () => {
  // 生成器原本只認得四個情境，所以餐飲、購物、健康、學習曾經都是 0
  // （設定頁那八顆按鈕照樣點得下去，點了會靜靜退回全部題目，所以沒人發現）。
  // 兩邊都補齊八個了，**這條釘的是「不能再變少」**。
  const covered = (file) => new Set(load(file).map((x) => x.category)).size;
  assert.ok(covered('listening.json') >= 8, `聽力只涵蓋 ${covered('listening.json')} 個情境`);
  assert.ok(covered('dialogues.json') >= 8, `對話只涵蓋 ${covered('dialogues.json')} 個情境`);

  // 每個情境至少要有 5 筆才算「這個情境練得起來」——
  // 只有一兩筆的話，設定頁篩了它就是同一題一直重複
  for (const file of ['listening.json', 'dialogues.json']) {
    for (const [c, n] of Object.entries(
      load(file).reduce((acc, x) => ({ ...acc, [x.category]: (acc[x.category] ?? 0) + 1 }), {})
    )) {
      assert.ok(n >= 5, `${file} 的「${c}」只有 ${n} 筆`);
    }
  }

  // 情境本身一定要是 App 認得的那八個，不然設定頁篩不到它
  for (const file of ['listening.json', 'dialogues.json']) {
    for (const item of load(file)) {
      assert.ok(CATEGORIES.includes(item.category), `${file} #${item.id}：${item.category}`);
      assert.ok(DIFFICULTIES.includes(item.difficulty), `${file} #${item.id}：${item.difficulty}`);
    }
  }
});

// ─── 併進現有內容 ────────────────────────────────────────────────────────

test('新的 id 接在現有的最大值後面，不是接在筆數後面', () => {
  // 中間刪過幾筆的話，用筆數算會撞號 —— 而撞號的症狀是
  // 「練習紀錄指到別的題目」（紀錄存的是 id），不會有錯誤訊息
  const existing = [{ id: 1, title: 'a' }, { id: 7, title: 'b' }];
  const merged = mergeIntoExisting(existing, [{ title: 'c' }, { title: 'd' }]);

  assert.deepEqual(merged.map((x) => x.id), [1, 7, 8, 9]);
  assert.equal(merged.length, 4);
  // 現有的那幾筆原封不動
  assert.deepEqual(merged.slice(0, 2), existing);
});

test('本來就沒有內容時從 1 開始', () => {
  assert.deepEqual(mergeIntoExisting([], [{ title: 'a' }]).map((x) => x.id), [1]);
});

test('壞掉的 id 不會讓後面全部變成 NaN', () => {
  const merged = mergeIntoExisting([{ id: 'x', title: 'a' }, { id: 3, title: 'b' }], [{ title: 'c' }]);
  assert.equal(merged[2].id, 4);
});

// ─── keywords 要對得上每一種「可接受的說法」───────────────────────────────

/** 有幾個 accept 變體裡少了自己那一輪的 keywords（用 grade() 的 tokens 語意）。 */
function keywordMismatches(dialogues) {
  const misses = [];
  for (const item of dialogues) {
    for (const turn of item.turns.filter((t) => t.speaker === 'you')) {
      for (const variant of turn.accept ?? []) {
        const got = new Set(tokens(variant));
        const missing = (turn.keywords ?? []).filter((k) => !tokens(k).every((w) => got.has(w)));
        if (missing.length) misses.push({ id: item.id, variant, missing });
      }
    }
  }
  return misses;
}

/** 目前的欠債。**只能往下降，不能往上加**（下面那條測試就是為此存在）。 */
const KEYWORD_DEBT = 132;

test('keywords 對不上 accept 的數量不能再變多', () => {
  // 為什麼這是問題：`grade()` 先比對 accept 完全相符（那會判「完全正確」），
  // 但**照著 accept[1] 的意思改寫一下**就只剩 keywords 那條路 ——
  // 而 keywords 只保證在 answer 裡找得到。所以使用者寫出一個畫面上列為
  // 「其他說法」的變化型，卻被判「再想想」。中翻英那邊的手寫題目踩過同一個坑
  // （見 TODO 的「內容」那一段）。
  //
  // 既有的 61 段有 132 個這種變體，一筆一筆看才修得好（要換 keywords 還是換說法
  // 是內容判斷），所以這裡先用**棘輪**釘住：新加的內容不准再往上加。
  const misses = keywordMismatches(load('dialogues.json'));
  assert.ok(
    misses.length <= KEYWORD_DEBT,
    `變成 ${misses.length} 個（上限 ${KEYWORD_DEBT}）。新加的那幾筆：` +
      misses.slice(-3).map((m) => `#${m.id} 缺 ${m.missing.join('/')}`).join('；')
  );
});

test('每一個 accept 自己送進 grade() 都要判成「完全正確」', () => {
  // 這是使用者看得到的承諾：畫面上列出來的「其他說法」照著寫一定要對。
  // 完全相符那條路走的是 normalize()，所以這條實際上釘的是
  // 「accept 裡沒有前後空白、全形標點之類會讓比對失敗的髒東西」
  for (const item of load('dialogues.json')) {
    for (const turn of item.turns.filter((t) => t.speaker === 'you')) {
      for (const variant of turn.accept ?? []) {
        const level = grade(turn, variant).level;
        assert.equal(level, 'exact', `#${item.id}「${variant}」判成 ${level}`);
      }
    }
  }
});
