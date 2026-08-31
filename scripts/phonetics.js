// 用 CMU 發音字典判斷「這句適合拿來練哪些音」。
//
// 這是句庫能不能長大的關鍵：`focus` 原本要人工標，一句一句標到 81 句就標不動了。
//
// **重點是「密度」而不是「有沒有」。** 第一版寫成「句子裡有 TH 就標 th」，
// 拿現有 81 句人工標的當對照跑出來：人工標的 90% 有抓到，但每句被多抓 5～7 個 ——
// 因為隨便一句英文都含 R 和 L、都有字尾子音。標籤掛滿等於沒有標籤。
// 所以改成算每個音的密度，只留分數最高的兩個。

import { dictionary } from 'cmu-pronouncing-dictionary';

/** ARPAbet 的母音。判斷音節、字尾子音叢集都要用。 */
const VOWELS = new Set([
  'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER',
  'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW',
]);

/** 去掉重音標記（IH1 → IH）。 */
const base = (phone) => phone.replace(/\d/g, '');

/** 把句子切成單字。撇號要留著，don't 查得到、dont 查不到。 */
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[’]/g, "'")
    .match(/[a-z']+/g) ?? [];
}

/**
 * 查一句話裡每個字的音素。
 * @returns {Array<{word: string, phones: string[]}>|null} 有任何一個字查不到就回 null
 */
export function pronounce(text) {
  const out = [];
  for (const word of tokenize(text)) {
    const entry = dictionary[word] ?? dictionary[word.replace(/^'|'$/g, '')];
    if (!entry) return null;
    out.push({ word, phones: entry.split(' ').map(base) });
  }
  return out.length > 0 ? out : null;
}

/** 一個字的音節數 = 母音數。三音節以上才有「重音放錯」的問題。 */
export function syllables(phones) {
  return phones.filter((p) => VOWELS.has(p)).length;
}

/** 字尾的子音叢集（從後面數到第一個母音為止）。 */
function finalCluster(phones) {
  const tail = [];
  for (let i = phones.length - 1; i >= 0; i -= 1) {
    if (VOWELS.has(phones[i])) break;
    tail.unshift(phones[i]);
  }
  return tail;
}

/**
 * 每個發音問題類型的「這句練得到多少」分數。
 *
 * 分數都除以字數，這樣長句不會只因為字多就每個音都拿高分。
 *
 * @param {string} text
 * @returns {Map<string, number>|null} 查不到發音時回 null
 */
export function issueScores(text) {
  const words = pronounce(text);
  if (!words) return null;

  const n = words.length;
  const flat = words.flatMap((w) => w.phones);
  const count = (phone) => flat.filter((p) => p === phone).length;
  const scores = new Map();
  const add = (issue, value) => {
    if (value > 0) scores.set(issue, (scores.get(issue) ?? 0) + value);
  };

  // th：θ 與 ð 出現得越多越好練
  add('th', (count('TH') + count('DH')) / n);

  // r_l、v_w：兩個音都要出現才有「分辨」可言，只有 r 沒有 l 練不到混淆
  const r = count('R');
  const l = count('L');
  if (r > 0 && l > 0) add('r_l', Math.min(r, l) / n);
  const v = count('V');
  const w = count('W');
  if (v > 0 && w > 0) add('v_w', Math.min(v, w) / n);

  add('n_ng', count('NG') / n);

  // 長短母音：要成對出現才練得到 ship／sheep 這種對比
  const pairs = [['IY', 'IH'], ['UW', 'UH'], ['AE', 'EH']];
  for (const [long, short] of pairs) {
    if (count(long) > 0 && count(short) > 0) {
      add('vowel_length', Math.min(count(long), count(short)) / n);
    }
  }

  let finalStop = 0;
  let cluster = 0;
  let inflection = 0;
  let longWords = 0;
  for (const { word, phones } of words) {
    const tail = finalCluster(phones);
    if (tail.length >= 1 && ['T', 'D', 'K', 'G', 'P', 'B'].includes(tail.at(-1))) finalStop += 1;
    if (tail.length >= 2) cluster += 1;
    // 字尾 -s／-ed 真的有發出來的才算（house 的 s 不是這回事）
    if (/(s|es)$/.test(word) && ['S', 'Z'].includes(phones.at(-1))) inflection += 1;
    if (/ed$/.test(word) && ['T', 'D'].includes(phones.at(-1))) inflection += 1;
    if (syllables(phones) >= 3) longWords += 1;
  }
  add('final_consonant', finalStop / n);
  add('extra_vowel', cluster / n);
  add('plural_ed', inflection / n);
  add('stress', longWords / n);

  // 連音：子音結尾的字後面接母音開頭的字
  let links = 0;
  for (let i = 0; i < words.length - 1; i += 1) {
    const prev = words[i].phones.at(-1);
    const next = words[i + 1].phones[0];
    if (!VOWELS.has(prev) && VOWELS.has(next)) links += 1;
  }
  add('linking', links / n);

  return scores;
}

/**
 * 各個音在語料庫裡的平均密度。
 *
 * 沒有這張表的話標籤會全部被 final_consonant 與 linking 佔滿 ——
 * 那兩個是英文的結構特性（幾乎每句都有），不是「這句特別適合練它」。
 * v_w 的平均只有 final_consonant 的十二分之一，兩者的絕對分數本來就不能直接比。
 *
 * 數字是拿 Tatoeba 語料裡 54,664 句 5～13 字的句子實際跑出來的平均值，
 * 由 `npm run corpus:baseline` 重算（換語料庫要重跑，不然門檻會偏掉）。
 */
export const BASELINE = new Map([
  ['final_consonant', 0.2249],
  ['linking', 0.148],
  ['plural_ed', 0.1418],
  ['extra_vowel', 0.1288],
  ['vowel_length', 0.1225],
  ['th', 0.0995],
  ['r_l', 0.0623],
  ['stress', 0.0608],
  ['n_ng', 0.0409],
  ['v_w', 0.0191],
]);

/**
 * 這句該標哪些 focus。
 *
 * 每個音的密度先除以它在語料庫裡的平均，比的是「**比一般句子強多少倍**」，
 * 再取最強的前 `limit` 個。門檻 `minRatio` 擋掉「只是剛好有」的音 ——
 * 標籤掛滿等於沒有標籤，使用者看到「這句在練 th」時要真的是在練 th。
 *
 * @returns {string[]} 由強到弱；查不到發音或都不夠突出時回空陣列
 */
export function focusTags(text, { limit = 2, minRatio = 1.6, baseline = BASELINE } = {}) {
  const scores = issueScores(text);
  if (!scores) return [];

  return [...scores.entries()]
    .map(([issue, value]) => [issue, value / (baseline.get(issue) ?? 1)])
    .filter(([, ratio]) => ratio >= minRatio)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([issue]) => issue);
}
