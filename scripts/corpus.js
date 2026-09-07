// Tatoeba 語料的共用清洗規則。
//
// 為什麼要有這一份：`import-sentences.mjs`（跟讀句庫）與 `import-translation.mjs`
// （中翻英題庫）吃的是同一批 Tatoeba 句對，該擋的東西也一模一樣 ——
// 全形標點、破碎的引文、讓人不舒服的內容、佔位人名（Tom）、古英文…
// 兩邊各留一份的話，補了其中一邊的漏網之魚，另一邊還是會放它進去。
//
// 這裡只放「跟語料有關、跟用途無關」的東西。用途專屬的規則留在各自的腳本裡：
// 跟讀要的 focus 標籤（這句在練哪些音）、中翻英要的中文側檢查與關鍵字，
// 都不屬於這裡。
//
// 資料來源：Tatoeba（https://tatoeba.org/），授權 CC BY 2.0 FR。

import * as OpenCC from 'opencc-js';

import { pronounce, syllables } from './phonetics.js';

/**
 * 情境的關鍵字，由上往下比對，先中的算。
 *
 * 順序有意義：`interview` 排最前面，但它的字要夠專屬 ——
 * 早期版本把 `company`／`experience`／`skill` 放進面試，結果職場的句子全被搶走。
 * 通用的求職字（job、work、company）留給 `work`。
 */
export const CATEGORY_RULES = [
  ['interview', /\b(interview|interviews|interviewer|resume|hire|hired|hiring|candidate|applicant|apply|applied|application|qualification|qualifications|internship|recruiter|employer|promotion|resign|resigned|references|strengths|weakness)\b/i],
  ['travel', /\b(flight|flights|airport|airline|hotel|hostel|ticket|tickets|passport|visa|luggage|baggage|suitcase|boarding|terminal|platform|station|train|subway|taxi|cab|tour|tourist|sightseeing|souvenir|reservation|itinerary|abroad|overseas|trip|travel|traveled|traveling|vacation|beach|museum|currency|customs|departure|arrival|aisle|cruise|foreign|airplane|plane|highway|hitchhike)\b/i],
  ['work', /\b(meeting|meetings|email|emails|deadline|colleague|colleagues|client|clients|presentation|budget|invoice|contract|overtime|memo|conference|department|manager|boss|staff|paperwork|proposal|workplace|coworker|report|reports|project|projects|office|job|jobs|work|works|working|worked|company|companies|employee|employees|business|salary|wage|career|position|experience|skill|skills|schedule|scheduled|task|tasks|document|documents|sales|customer)\b/i],
  ['health', /\b(doctor|dentist|hospital|clinic|nurse|patient|medicine|pill|pills|fever|headache|cough|flu|ache|aches|exercise|exercises|gym|health|healthy|appointment|checkup|symptom|allergy|allergic|stomach|throat|tooth|teeth|prescription|dose|nap|asleep|awake|sick|ill|illness|pain|rest|rested|sleep|sleeping|slept|tired|weight|diet|smoking|smoke|smoked|vitamin|treatment|recover|recovered|breathe|breathing|heart|temperature|bandage|injury|dizzy|sore)\b/i],
  ['school', /\b(school|schools|class|classes|classroom|teacher|teachers|student|students|study|studied|studying|homework|exam|exams|grade|grades|university|college|course|courses|lesson|lessons|library|semester|professor|textbook|dictionary|notebook|graduate|graduated|major|majored|degree)\b/i],
  ['shopping', /\b(buy|buys|buying|bought|shop|shops|shopping|store|stores|price|prices|cheap|cheaper|expensive|cost|costs|sale|discount|receipt|refund|cash|dollar|dollars|size|clothes|shirt|shoes|jacket|supermarket|deliver|delivery|package|wallet|purse|credit)\b/i],
  ['food', /\b(eat|eats|eating|ate|food|foods|restaurant|menu|dinner|lunch|breakfast|meal|meals|coffee|tea|juice|cook|cooked|cooking|kitchen|delicious|taste|tastes|hungry|thirsty|dish|dishes|bread|rice|meat|fish|fruit|vegetable|vegetables|dessert|cake|sugar|salt|milk|egg|eggs|soup|snack|cheese|butter|noodles|drink|drinks)\b/i],
];

// ─── 語料清洗 ────────────────────────────────────────────────────────────

/**
 * 只收乾淨的 ASCII 句子。全形標點、括號、分號都代表這句不是單純的一句話。
 *
 * 阿拉伯數字也不收：「My salary is 300,000 yen.」唸出來是什麼取決於使用者怎麼讀，
 * 而目標句要拿去跟 AI 聽到的內容逐字比對 —— 數字一定對不上。
 * 要練數字的話，句子裡直接寫成英文（seven thirty）才比得了。
 */
export const CLEAN = /^[A-Za-z ,.'?!-]+$/;

/** 對白標記與破碎的引文：句子被從一段對話裡切出來，單獨看不成立。 */
export const FRAGMENT = /\b(said|says|replied|asked him|asked her|murmured|muttered|exclaimed)\b/i;

/**
 * 讓人不舒服的內容。
 *
 * Tatoeba 是通用語料，裡面什麼都有 ——「An old woman was burnt to death.」
 * 文法完全正確、也通過了上面每一道清洗，但沒有人想在練發音的時候唸這句。
 *
 * 這是**鈍器**：關鍵字擋不掉全部，也一定會誤傷（`afraid` 就不能放進來，
 * 不然「I'm afraid my luggage didn't arrive」與「Don't be afraid to ask questions」
 * 都會被砍掉）。所以只放那些「出現了幾乎一定不合適」的字，其餘靠人看。
 */
export const UNPLEASANT = /\b(die|died|dies|dying|death|dead|kill|killed|killing|murder|murdered|suicide|corpse|funeral|grave|buried|burnt|blood|bleeding|wound|wounded|war|soldier|soldiers|army|gun|guns|weapon|bomb|bombs|shoot|shot|violence|violent|rape|sex|sexual|naked|drunk|drug|drugs|cancer|tumor|disease|dying|prison|jail|arrest|arrested|thief|robbery|murderer|slave|slavery|abuse|starve|starving|famine|flood|earthquake|disaster|tragedy|depressed|depression|tears|weep|wept|mourn|grief|hell|damn|idiot|stupid|ugly)\b/i;

/** 不夠自然的寫法。`can not` 幾乎都該是 `cannot`，唸起來的節奏也不一樣。 */
export const AWKWARD = /\bcan not\b/i;

/** 承接上文的開頭，代表這句原本有前一句。 */
export const LEAD_CONJ = /^(but|and|so|then|yet|nor|because|though|although|however|besides|still|thus|hence|moreover|therefore|meanwhile|anyway|otherwise)\b/i;

/** 時代感太重的用字，混進來整份句庫會讀起來像老小說。 */
export const PERIOD = /\b(thee|thou|thy|thine|hath|doth|whilst|nay|yonder|betwixt|shalt|unto|hither|sire|madam|alas|perchance|methinks|forsooth|steed|parlour|governess|footman|butler|squire|vicar)\b/i;

/** 古英文的否定語序：are not you／have not you。 */
export const OLD_ORDER = /\b(are|is|was|were|have|has|had|do|does|did|will|would|shall|should|can|could)\s+not\s+(you|it|we|i)\b/i;

/**
 * 第三人稱敘事（他／她）。
 *
 * 「He left his office in a hurry.」文法沒問題，但那是在講故事，不是在對話 ——
 * 而這個 App 練的是開口跟人講話。留下來的會是「我／你／我們」與一般性的句子。
 */
export const THIRD_PERSON = /\b(he|him|his|she|her|hers)\b/i;

export const words = (text) => text.split(/\s+/).filter(Boolean);
export const lower = (text) => text.toLowerCase().replace(/[^a-z0-9 ']/g, ' ').split(/\s+/).filter(Boolean);

/** 正規化後拿來比對重複。標點與大小寫不同不算兩句。 */
export const dedupeKey = (text) => lower(text).join(' ');

/**
 * 語料裡每個小寫字出現幾次。
 *
 * 用途有兩個：擋掉冷僻字（練習句不該考單字），以及判斷句首的大寫字是不是專有名詞 ——
 * 「Tom」在語料裡從來不會以小寫出現，「Please」會。Tatoeba 有 5,825 句以 Tom 開頭，
 * 那是佔位用的人名，練起來沒有意義，而寫死一份人名清單永遠會漏。
 */
export function buildFrequency(corpus) {
  const all = new Map();
  const lowercase = new Map();
  for (const text of corpus) {
    const tokens = text.split(/\s+/);
    for (const raw of tokens) {
      const clean = raw.replace(/[^A-Za-z0-9']/g, '');
      if (!clean) continue;
      const key = clean.toLowerCase();
      all.set(key, (all.get(key) ?? 0) + 1);
      // 原文就是小寫才算 —— 用來分辨「Tom」（永遠大寫＝人名）與「Please」（也會小寫出現）
      if (clean[0] === clean[0].toLowerCase()) {
        lowercase.set(key, (lowercase.get(key) ?? 0) + 1);
      }
    }
  }
  return { all, lowercase };
}

/**
 * 這句英文能不能拿來當練習素材。
 *
 * `minWords` / `maxWords` 是唯一由呼叫端決定的東西，因為兩種用途的理由不同：
 * 跟讀要「一口氣唸得完」所以上限 13；中翻英是用打的，可以再長一點，
 * 但太短的句子（「Thank you.」）翻起來沒有練到什麼，下限反而更該守。
 */
export function acceptSentence(text, freq, { minWords, maxWords }) {
  if (!CLEAN.test(text)) return false;
  if (!/[.?!]$/.test(text)) return false;

  const w = words(text);
  if (w.length < minWords || w.length > maxWords) return false;

  if (FRAGMENT.test(text) || LEAD_CONJ.test(text) || PERIOD.test(text) || OLD_ORDER.test(text)) {
    return false;
  }
  if (AWKWARD.test(text)) return false;
  if (UNPLEASANT.test(text)) return false;
  if (THIRD_PERSON.test(text)) return false;

  // 句中的大寫字＝專有名詞（人名、地名、品牌），換成別的字就不通了，也讓句子變得很特定
  for (const token of w.slice(1)) {
    const clean = token.replace(/[^A-Za-z']/g, '');
    if (clean.length > 1 && /^[A-Z]/.test(clean) && clean !== 'I') return false;
  }

  // 句首的大寫字：這個字在語料裡也會以小寫出現，才是一般的字；否則是人名
  const first = w[0].replace(/[^A-Za-z']/g, '').toLowerCase();
  if (!first || (freq.lowercase.get(first) ?? 0) < 30) return false;

  // 每個字都要查得到發音（查不到多半是拼錯、專有名詞或縮寫），而且不能太冷僻
  const said = pronounce(text);
  if (!said) return false;
  for (const { word } of said) {
    if ((freq.all.get(word) ?? 0) < 8) return false;
  }
  return true;
}

// ─── 分類與難度 ──────────────────────────────────────────────────────────

export function categorise(text) {
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(text)) return category;
  }
  return 'daily';
}

/**
 * 難度。三個訊號：句子長度、最冷僻的那個字有多冷僻、幾個字有三個音節以上。
 * 都跟「唸起來有多難」直接相關，而不是文法程度。
 */
export function difficulty(text, freq) {
  const said = pronounce(text);
  const w = words(text);
  const rarest = Math.min(...said.map(({ word }) => freq.all.get(word) ?? 0));
  const longWords = said.filter(({ phones }) => syllables(phones) >= 3).length;

  if (w.length >= 11 || rarest < 15 || longWords >= 3) return 'hard';
  if (w.length <= 8 && rarest >= 60 && longWords === 0) return 'easy';
  return 'medium';
}

const convert = OpenCC.Converter({ from: 'cn', to: 'twp' });

/**
 * OpenCC 轉不對的少數詞。
 *
 * 簡體的「发」對應到正體的「發」與「髮」兩個字，靠詞組判斷 ——
 * 詞組表沒收的組合（例如「被发明」）就會轉成「被髮明」。305 句裡只中一句，
 * 但那一句在畫面上就是個錯字。`test/sentences.test.js` 有一條會掃這些型樣，
 * 之後匯入時再撞到別的，補進這張表即可。
 */
export const FIXES = [
  [/髮明/g, '發明'],
  [/髮現/g, '發現'],
  [/髮生/g, '發生'],
  [/髮展/g, '發展'],
  [/髮出/g, '發出'],
  [/頭發/g, '頭髮'],
];

export function toTraditional(text) {
  return FIXES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), convert(text));
}
