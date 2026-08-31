// 把 Azure 的評估結果對應成我們的「發音問題類型」。
//
// 為什麼需要這一層：Azure 給的是**客觀但原始**的資料（每個音素一個準確度分數、
// 每個字一個 errorType），而抽句加權要的是分類 —— 「這個人 th 一直有問題」。
// 沒有這層對應的話，Azure 的分數只能看，不能回頭影響出題。
//
// 這是整合兩個分支的接點：
//   Azure（客觀評分）→ 這裡（分類）→ practice.js 的 weakIssues()（加權抽句）
//
// 對照 server/gemini.js 的 ISSUE_CODES —— 兩邊要用同一組代碼，
// 不然畫面上的中文標籤會查不到。

/**
 * IPA 音素 → 問題類型。
 *
 * `paConfig.phonemeAlphabet = 'IPA'`（見 server/azure-pronunciation.js），
 * 所以這裡收的是 IPA 而不是 ARPAbet。
 *
 * 刻意**沒有**收 `n`：它在英文裡太常見，一旦誤判就會把所有問題都算成 n_ng。
 * 只收 ŋ，寧可漏抓也不要亂抓。
 */
const PHONEME_ISSUES = new Map([
  ['θ', 'th'], ['ð', 'th'],
  ['ɹ', 'r_l'], ['r', 'r_l'], ['l', 'r_l'], ['ɫ', 'r_l'],
  ['v', 'v_w'], ['w', 'v_w'], ['ʋ', 'v_w'],
  ['ŋ', 'n_ng'],
  // 長短母音：中文母語者最常混的幾組（ship／sheep、full／fool、bad／bed）
  ['i', 'vowel_length'], ['ɪ', 'vowel_length'],
  ['u', 'vowel_length'], ['ʊ', 'vowel_length'],
  ['æ', 'vowel_length'], ['ɛ', 'vowel_length'], ['e', 'vowel_length'],
]);

/** 字尾這幾個塞音沒發出來，是中文母語者非常典型的問題。 */
const FINAL_STOPS = new Set(['p', 'b', 't', 'd', 'k', 'ɡ', 'g']);

/**
 * Azure 的 errorType → 問題類型。
 *
 * Insertion（多唸了一個字）刻意不對應到 `extra_vowel` ——
 * extra_vowel 指的是「字尾多加一個母音」（and 唸成 an-de），是音素層的事，
 * 跟「多唸一個字」不一樣。硬對過去會讓弱點統計失真。
 */
const ERROR_ISSUES = new Map([
  ['Monotone', 'stress'],
  ['UnexpectedBreak', 'linking'],
  ['MissingBreak', 'linking'],
]);

/** 音素分數低於這個就算有問題。Azure 的滿分是 100。 */
export const PHONEME_THRESHOLD = 60;

/** 整個字的準確度低於這個才會被列進來（跟畫面上「需要加強的字」同一條線）。 */
export const WORD_THRESHOLD = 80;

/**
 * 去掉 IPA 的長度與重音記號。
 *
 * `iː` 與 `i` 都對應到同一個問題類型（長短母音），所以正規化掉反而更準；
 * 重音記號 ˈ ˌ 會讓查表失敗，一定要去掉。
 */
function normalizePhoneme(symbol) {
  return String(symbol ?? '')
    .replace(/[ːˈˌ.͜͡]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * 一個字裡最該被點名的問題類型。
 *
 * 判斷順序是刻意的：**先看具體的音素，再看字層的錯誤類型**。
 * 「th 唸錯」比「這個字準確度低」有用得多，反過來排的話具體資訊會被蓋掉。
 *
 * @returns {string|null} issue 代碼；沒有明顯問題時回 null
 */
export function issueForWord(word) {
  if (!word) return null;

  const phonemes = Array.isArray(word.phonemes) ? word.phonemes : [];
  const weak = phonemes.filter((p) => (p.accuracy ?? 100) < PHONEME_THRESHOLD);

  // ① 分數最低的音素查得到分類就用它
  const sorted = [...weak].sort((a, b) => (a.accuracy ?? 0) - (b.accuracy ?? 0));
  for (const p of sorted) {
    const issue = PHONEME_ISSUES.get(normalizePhoneme(p.phoneme));
    if (issue) return issue;
  }

  // ② 字尾的塞音沒發出來
  const last = phonemes.at(-1);
  if (last && (last.accuracy ?? 100) < PHONEME_THRESHOLD &&
      FINAL_STOPS.has(normalizePhoneme(last.phoneme))) {
    return 'final_consonant';
  }

  // ③ 字層的錯誤類型
  const byError = ERROR_ISSUES.get(word.errorType);
  if (byError) return byError;

  // ④ 有明顯問題但歸不到任何一類
  const hasProblem =
    (word.errorType && word.errorType !== 'None') ||
    (word.accuracy ?? 100) < WORD_THRESHOLD ||
    weak.length > 0;
  return hasProblem ? 'other' : null;
}

/**
 * 把整份 Azure 評估轉成 `practice.js` 吃得下的 problemWords。
 *
 * 形狀跟 Gemini 路徑一致（word / heard / issue / tip_zh），這樣練習紀錄
 * 不管是哪個供應商產生的，弱點統計與一組總結都用同一段程式讀。
 *
 * `heard` 留空是誠實的做法 —— Azure 給的是分數，不是「你唸成了什麼」，
 * 硬要從 recognizedText 猜哪個字對哪個字只會編出錯的東西。
 *
 * @param {object} assessment `/api/pronunciation-feedback` 的 Azure 回應
 * @param {number} [limit] 最多取幾個字（跟 Gemini 路徑一樣是 3）
 */
export function problemWordsFromAssessment(assessment, limit = 3) {
  const words = Array.isArray(assessment?.words) ? assessment.words : [];

  const scored = words
    .map((w) => ({ word: w, issue: issueForWord(w) }))
    .filter((x) => x.issue && x.word.word)
    // 漏字（Omission）不列：那是「沒唸」不是「唸錯」，混在一起會讓弱點統計失真
    .filter((x) => x.word.errorType !== 'Omission')
    .sort((a, b) => (a.word.accuracy ?? 100) - (b.word.accuracy ?? 100));

  return scored.slice(0, limit).map(({ word, issue }) => ({
    word: word.word,
    heard: '',
    issue,
    tip_zh: '',
    accuracy: word.accuracy ?? null,
  }));
}

/**
 * 語調分數很低時額外補一筆 stress。
 *
 * Azure 的 prosody 是整句的分數，不掛在任何一個字上 —— 但「重音與節奏不自然」
 * 是實際存在的弱點，不記錄的話抽句永遠不會多給重音難的句子。
 */
export function prosodyIssue(assessment, threshold = 60) {
  const prosody = assessment?.scores?.prosody;
  if (typeof prosody !== 'number' || prosody >= threshold) return null;
  return { word: assessment.referenceText?.split(/\s+/)[0] ?? '', heard: '', issue: 'stress', tip_zh: '' };
}
