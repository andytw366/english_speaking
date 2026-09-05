// 單字卡的選擇題：出題與干擾項規則。
//
// **為什麼是選擇題而不是打字**：輸入式最大的問題不是程式，是資料 ——
// 10,000 個字裡有 2,928 個（29%）跟別的字共用同一個中文義項
// （「完全地」有 7 個字：absolutely / completely / totally / perfectly…）。
// 看中文打英文的話，使用者打了一個「也對」的答案卻被判錯，只能靠一顆
// 「其實我對了」的按鈕擦屁股。
//
// 選擇題把這件事變成規則的一部分：**義項重疊的字不可以當干擾項**，
// 所以題目本身就不會有兩個對的答案。順帶還拿到三件事：
//   1. 批改 100% 準確，中→英與英→中都一樣（英→中打字幾乎無法批改）
//   2. 手機上一按就好，不用切輸入法
//   3. 間隔重複的訊號變客觀 —— 不再是使用者自己按「記得 / 還不熟」
//
// 這個模組是純函式（不碰 DOM、不碰 localStorage），亂數也用參數注入，
// 所以 `quiz.test.js` 測得到「干擾項不會跟答案同義」這種規則。

/** 題型。`flip` 是原本的翻卡，留著讓想自己回想的人用。 */
export const QUIZ_TYPES = [
  { id: 'zh2en', label: '看中文選英文' },
  { id: 'en2zh', label: '看英文選中文' },
  { id: 'flip', label: '翻卡（自己判斷記不記得）' },
];

export const QUIZ_TYPE_IDS = QUIZ_TYPES.map((t) => t.id);

/** 一題幾個選項。四選一：夠難，但在手機上一頁還放得下。 */
export const OPTION_COUNT = 4;

/**
 * 一個字的所有中文義項。
 *
 * ECDICT 的 `meaning_zh` 是多行多義、還混了 `[化]` 這種領域標記，
 * 義項數中位數 4、90% 有 9 個。切開之後才比得出「這兩個字是不是同義」。
 */
export function senses(meaningZh) {
  return new Set(
    String(meaningZh ?? '')
      .split(/[\n,、;；]/)
      .map((part) => part.replace(/^\[[^\]]*\]\s*/, '').trim())
      .filter(Boolean)
  );
}

/** 拿來當題目或選項的那一個中文意思：第一個義項。 */
export function firstSense(meaningZh) {
  const [first] = senses(meaningZh);
  return first ?? '';
}

/** 選項複習清單上要顯示幾個義項。四個以上就開始蓋掉重點。 */
export const BRIEF_SENSES = 3;

/**
 * 一個字的意思講短一點：前幾個義項，多的用省略號帶過。
 *
 * 為什麼不直接印 `meaning_zh`：ECDICT 的釋義是多行多義，`go` 有 20 個義項、
 * `make` 有 19 個，整坨貼在四個干擾項下面會變成一面牆 —— 而這一段的用途是
 * 「順便瞄一眼另外三個字是什麼意思」，不是查字典。
 */
export function briefMeaning(meaningZh, max = BRIEF_SENSES) {
  const list = [...senses(meaningZh)];
  const shown = list.slice(0, Math.max(1, max));
  return shown.join('、') + (list.length > shown.length ? '…' : '');
}

/**
 * 一個選項要帶的東西。
 *
 * 除了顯示用的 `text`，**每個選項都帶著它自己那個字的字、音標、詞性與簡短釋義** ——
 * 答完之後畫面要讓使用者順便看／聽另外三個選項是什麼字。資料在出題的時候就
 * 抓下來，呼叫端不必為了三個干擾項再回頭去 pool 裡查（pool 是一整級 1,300～2,100
 * 個字，而且 `prepareCard()` 之後 question 就是那一題的全部資料了）。
 */
function toOption(source, text, correct) {
  return {
    id: source.id,
    text,
    correct,
    word: source.word ?? '',
    ipa: source.ipa ?? '',
    pos: source.pos ?? '',
    meaning: briefMeaning(source.meaning_zh),
  };
}

/**
 * 這兩個字可不可以放在同一題裡。
 *
 * 兩條規則：
 *   1. **義項完全不重疊** —— 這是「一題只有一個正確答案」的唯一保證
 *   2. 詞性一樣（兩邊都有詞性時才比）—— 選項詞性混在一起的話，
 *      光看詞性就能刪掉一半，題目變得太好猜。ECDICT 有近兩成的字沒有詞性，
 *      那種情況就不比
 */
export function canDistract(card, other) {
  if (!other || other.id === card.id || other.word === card.word) return false;
  if (card.pos && other.pos && card.pos !== other.pos) return false;

  const mine = senses(card.meaning_zh);
  for (const sense of senses(other.meaning_zh)) {
    if (mine.has(sense)) return false;
  }
  return true;
}

/**
 * 出一題。
 *
 * @param {object} card 正確答案那張卡
 * @param {object[]} pool 干擾項的來源（目前這一級的全部字）
 * @param {object} options
 * @param {'zh2en'|'en2zh'} options.direction
 * @param {number} [options.count] 選項數
 * @param {() => number} [options.random] 亂數來源（測試會注入）
 * @returns {{direction: string, card: object, prompt: string, promptHint: string,
 *   options: Array<{id: *, text: string, correct: boolean, word: string, ipa: string,
 *     pos: string, meaning: string}>} | null}
 *   湊不到足夠的干擾項時回 `null` —— 呼叫端要退回翻卡，不能出一題只有兩個選項的題目
 */
export function buildQuestion(card, pool, { direction, count = OPTION_COUNT, random = Math.random } = {}) {
  if (!card || !Array.isArray(pool)) return null;

  const answerText = direction === 'zh2en' ? card.word : firstSense(card.meaning_zh);
  if (!answerText) return null;

  const usable = pool.filter((other) => canDistract(card, other));
  // 詞性這條是「別讓題目太好猜」，不是安全規則 —— 湊不滿時先放掉它，
  // 但義項不重疊那條永遠不放。
  const relaxed = usable.length >= count - 1
    ? usable
    : pool.filter((other) => canDistract({ ...card, pos: '' }, other));

  const taken = new Set([answerText]);
  const distractors = [];
  for (const other of sample(relaxed, relaxed.length, random)) {
    const text = direction === 'zh2en' ? other.word : firstSense(other.meaning_zh);
    // 選項的文字也不能重複：兩個不同的字可能有一模一樣的第一個義項
    if (!text || taken.has(text)) continue;
    taken.add(text);
    distractors.push(toOption(other, text, false));
    if (distractors.length >= count - 1) break;
  }

  if (distractors.length < count - 1) return null;

  const options = sample(
    [toOption(card, answerText, true), ...distractors],
    count,
    random
  );

  return {
    direction,
    card,
    prompt: direction === 'zh2en' ? firstSense(card.meaning_zh) : card.word,
    // 中→英 的題目給詞性當提示（中文義項太短時很難猜），
    // 英→中 給音標 —— 反正答案是中文，音標不會洩題
    promptHint: direction === 'zh2en' ? (card.pos ?? '') : (card.ipa ?? ''),
    options,
  };
}

/**
 * 從 list 裡隨機取 n 個（不重複）。
 *
 * 為什麼不用「洗牌整個陣列」：pool 是一整級的字（1,300～2,100 個），
 * 每出一題洗一次太浪費。
 *
 * 亂數重複太多次就照順序補完 —— 測試會注入固定回傳值的假亂數，
 * 沒有這個保底就會卡在無窮迴圈裡。
 */
function sample(list, n, random) {
  const wanted = Math.min(n, list.length);
  const used = new Set();
  const chosen = [];

  for (let attempt = 0; chosen.length < wanted && attempt < wanted * 20; attempt++) {
    const i = Math.floor(random() * list.length);
    if (!Number.isFinite(i) || i < 0 || i >= list.length || used.has(i)) continue;
    used.add(i);
    chosen.push(list[i]);
  }
  for (let i = 0; chosen.length < wanted && i < list.length; i++) {
    if (!used.has(i)) {
      used.add(i);
      chosen.push(list[i]);
    }
  }
  return chosen;
}

/**
 * 這張卡這次要出哪一種題型。
 *
 * 使用者可以在設定裡勾要練哪些（可複選），勾越多混得越開。
 * 一個都沒勾就退回翻卡 —— 空的選擇不該讓單字卡整個不能用。
 */
export function pickType(enabled, random = Math.random) {
  const valid = (Array.isArray(enabled) ? enabled : []).filter((id) => QUIZ_TYPE_IDS.includes(id));
  if (valid.length === 0) return 'flip';
  const i = Math.floor(random() * valid.length);
  // Math.max(NaN, 0) 還是 NaN，夾範圍夾不掉壞掉的亂數 —— 要先擋 NaN，
  // 不然回傳的題型是 undefined，畫面會變成一張空白的卡
  if (!Number.isFinite(i)) return valid[0];
  return valid[Math.min(Math.max(i, 0), valid.length - 1)];
}
