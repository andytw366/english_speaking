// 從 Tatoeba 語料匯入練習句，自動標 focus 與難度。
//
//   node scripts/import-sentences.mjs            # 試跑，只印統計與樣本，不寫檔
//   node scripts/import-sentences.mjs --write    # 真的寫進 sentences.json
//
// 為什麼要有這支：`focus`（這句在練哪些音）原本要人工標，標到 81 句就標不動了 ——
// 而句庫不長，間隔重複與「多給你 th 的句子」這些功能就沒有素材可以發揮。
//
// 為什麼選 Tatoeba：它本來就是給語言學習者用的例句庫 —— 短、口語、現代。
// 對照組是 Mozilla Common Voice 的 CC0 語料（6.1 萬句，授權更寬鬆），
// 但那批多半來自公版小說，過濾到剩三千句還是有一半讀起來像十九世紀對白
// （「Are you a beast of the field?」），不適合拿來練「旅遊／職場」的情境。
//
// 資料來源：Tatoeba（https://tatoeba.org/），授權 CC BY 2.0 FR。
// 透過 npm 套件 tatoeba-sentence-pairs-in-mandarin-chinese-english 取得。

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import pairs from 'tatoeba-sentence-pairs-in-mandarin-chinese-english';
import * as OpenCC from 'opencc-js';

import { focusTags, issueScores, pronounce, syllables } from './phonetics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'sentences.json');
const HANDWRITTEN_DIR = path.join(ROOT, 'data');

/** 一句練習句的長度。太短練不到連音，太長一口氣唸不完、錄音也容易中斷。 */
const MIN_WORDS = 5;
const MAX_WORDS = 13;

/**
 * 每個情境要收到幾句。
 *
 * 250 句大約是「每天練 5～10 句、兩三個月不會重複」的量。再多其實也收得到
 * （候選池有一萬四千句），但每一句都會被抽到 —— 多不等於好。
 */
const QUOTA = 250;

/**
 * 情境的關鍵字，由上往下比對，先中的算。
 *
 * 順序有意義：`interview` 排最前面，但它的字要夠專屬 ——
 * 早期版本把 `company`／`experience`／`skill` 放進面試，結果職場的句子全被搶走。
 * 通用的求職字（job、work、company）留給 `work`。
 */
const CATEGORY_RULES = [
  ['interview', /\b(interview|interviews|interviewer|resume|hire|hired|hiring|candidate|applicant|apply|applied|application|qualification|qualifications|internship|recruiter|employer|promotion|resign|resigned|references|strengths|weakness)\b/i],
  ['travel', /\b(flight|flights|airport|airline|hotel|hostel|ticket|tickets|passport|visa|luggage|baggage|suitcase|boarding|terminal|platform|station|train|subway|taxi|cab|tour|tourist|sightseeing|souvenir|reservation|itinerary|abroad|overseas|trip|travel|traveled|traveling|vacation|beach|museum|currency|customs|departure|arrival|aisle|cruise|foreign|airplane|plane|highway|hitchhike)\b/i],
  ['work', /\b(meeting|meetings|email|emails|deadline|colleague|colleagues|client|clients|presentation|budget|invoice|contract|overtime|memo|conference|department|manager|boss|staff|paperwork|proposal|workplace|coworker|report|reports|project|projects|office|job|jobs|work|works|working|worked|company|companies|employee|employees|business|salary|wage|career|position|experience|skill|skills|schedule|scheduled|task|tasks|document|documents|sales|customer)\b/i],
  ['health', /\b(doctor|dentist|hospital|clinic|nurse|patient|medicine|pill|pills|fever|headache|cough|flu|ache|aches|exercise|exercises|gym|health|healthy|appointment|checkup|symptom|allergy|allergic|stomach|throat|tooth|teeth|prescription|dose|nap|asleep|awake|sick|ill|illness|pain|rest|rested|sleep|sleeping|slept|tired|weight|diet|smoking|smoke|smoked|vitamin|treatment|recover|recovered|breathe|breathing|heart|temperature|bandage|injury|dizzy|sore)\b/i],
  ['school', /\b(school|schools|class|classes|classroom|teacher|teachers|student|students|study|studied|studying|homework|exam|exams|grade|grades|university|college|course|courses|lesson|lessons|library|semester|professor|textbook|dictionary|notebook|graduate|graduated|major|majored|degree)\b/i],
  ['shopping', /\b(buy|buys|buying|bought|shop|shops|shopping|store|stores|price|prices|cheap|cheaper|expensive|cost|costs|sale|discount|receipt|refund|cash|dollar|dollars|size|clothes|shirt|shoes|jacket|supermarket|deliver|delivery|package|wallet|purse|credit)\b/i],
  ['food', /\b(eat|eats|eating|ate|food|foods|restaurant|menu|dinner|lunch|breakfast|meal|meals|coffee|tea|juice|cook|cooked|cooking|kitchen|delicious|taste|tastes|hungry|thirsty|dish|dishes|bread|rice|meat|fish|fruit|vegetable|vegetables|dessert|cake|sugar|salt|milk|egg|eggs|soup|snack|cheese|butter|noodles|drink|drinks)\b/i],
];

// ─── 語料清洗// ─── 語料清洗 ────────────────────────────────────────────────────────────

/**
 * 只收乾淨的 ASCII 句子。全形標點、括號、分號都代表這句不是單純的一句話。
 *
 * 阿拉伯數字也不收：「My salary is 300,000 yen.」唸出來是什麼取決於使用者怎麼讀，
 * 而目標句要拿去跟 AI 聽到的內容逐字比對 —— 數字一定對不上。
 * 要練數字的話，句子裡直接寫成英文（seven thirty）才比得了。
 */
const CLEAN = /^[A-Za-z ,.'?!-]+$/;

/** 對白標記與破碎的引文：句子被從一段對話裡切出來，單獨看不成立。 */
const FRAGMENT = /\b(said|says|replied|asked him|asked her|murmured|muttered|exclaimed)\b/i;

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
const UNPLEASANT = /\b(die|died|dies|dying|death|dead|kill|killed|killing|murder|murdered|suicide|corpse|funeral|grave|buried|burnt|blood|bleeding|wound|wounded|war|soldier|soldiers|army|gun|guns|weapon|bomb|bombs|shoot|shot|violence|violent|rape|sex|sexual|naked|drunk|drug|drugs|cancer|tumor|disease|dying|prison|jail|arrest|arrested|thief|robbery|murderer|slave|slavery|abuse|starve|starving|famine|flood|earthquake|disaster|tragedy|depressed|depression|tears|weep|wept|mourn|grief|hell|damn|idiot|stupid|ugly)\b/i;

/** 不夠自然的寫法。`can not` 幾乎都該是 `cannot`，唸起來的節奏也不一樣。 */
const AWKWARD = /\bcan not\b/i;

/** 承接上文的開頭，代表這句原本有前一句。 */
const LEAD_CONJ = /^(but|and|so|then|yet|nor|because|though|although|however|besides|still|thus|hence|moreover|therefore|meanwhile|anyway|otherwise)\b/i;

/** 時代感太重的用字，混進來整份句庫會讀起來像老小說。 */
const PERIOD = /\b(thee|thou|thy|thine|hath|doth|whilst|nay|yonder|betwixt|shalt|unto|hither|sire|madam|alas|perchance|methinks|forsooth|steed|parlour|governess|footman|butler|squire|vicar)\b/i;

/** 古英文的否定語序：are not you／have not you。 */
const OLD_ORDER = /\b(are|is|was|were|have|has|had|do|does|did|will|would|shall|should|can|could)\s+not\s+(you|it|we|i)\b/i;

/**
 * 第三人稱敘事（他／她）。
 *
 * 「He left his office in a hurry.」文法沒問題，但那是在講故事，不是在對話 ——
 * 而這個 App 練的是開口跟人講話。留下來的會是「我／你／我們」與一般性的句子。
 */
const THIRD_PERSON = /\b(he|him|his|she|her|hers)\b/i;

const words = (text) => text.split(/\s+/).filter(Boolean);
const lower = (text) => text.toLowerCase().replace(/[^a-z0-9 ']/g, ' ').split(/\s+/).filter(Boolean);

/** 正規化後拿來比對重複。標點與大小寫不同不算兩句。 */
const dedupeKey = (text) => lower(text).join(' ');

/**
 * 語料裡每個小寫字出現幾次。
 *
 * 用途有兩個：擋掉冷僻字（練習句不該考單字），以及判斷句首的大寫字是不是專有名詞 ——
 * 「Tom」在語料裡從來不會以小寫出現，「Please」會。Tatoeba 有 5,825 句以 Tom 開頭，
 * 那是佔位用的人名，練起來沒有意義，而寫死一份人名清單永遠會漏。
 */
function buildFrequency(corpus) {
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

/** 這句能不能用。回傳 null 代表淘汰，方便 filter 掉。 */
function accept(text, freq) {
  if (!CLEAN.test(text)) return false;
  if (!/[.?!]$/.test(text)) return false;

  const w = words(text);
  if (w.length < MIN_WORDS || w.length > MAX_WORDS) return false;

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

/**
 * 手寫的練習句：`data/<情境>.txt`，一行一句，`#` 開頭是註解。
 *
 * 為什麼需要這條路：Tatoeba 是通用語料，某些情境它就是給不出東西 ——
 * 面試類只有 95 句，其他情境都上千。那一類又剛好是最該有品質的
 * （會練它的人是真的要去面試），所以自己寫，然後走同一套清洗與自動標音。
 *
 * 手寫的句子跳過幾道語料專用的檢查（第三人稱、句首專有名詞、詞頻），
 * 那些是用來從一堆雜訊裡撈出好句子的；手寫的本來就是挑過的。
 */
function loadHandwritten() {
  let files = [];
  try {
    files = readdirSync(HANDWRITTEN_DIR).filter((f) => f.endsWith('.txt'));
  } catch {
    return []; // 沒有 data/ 目錄就是沒有手寫句子，不是錯誤
  }

  const out = [];
  for (const file of files) {
    const category = path.basename(file, '.txt');
    const lines = readFileSync(path.join(HANDWRITTEN_DIR, file), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    for (const text of lines) {
      const problem = handwrittenProblem(text);
      if (problem) {
        console.warn(`  ⚠ ${file}：${problem}　「${text}」`);
        continue;
      }
      out.push({ text, category, focus: tagsFor(text), handwritten: true });
    }
  }
  return out;
}

/** 手寫句子的檢查。回傳問題描述（好讓寫的人知道要改什麼），沒問題回 null。 */
function handwrittenProblem(text) {
  if (!CLEAN.test(text)) return '有不該出現的字元（全形標點、數字、括號？）';
  if (!/[.?!]$/.test(text)) return '結尾少了句號、問號或驚嘆號';
  const count = words(text).length;
  if (count < MIN_WORDS) return `只有 ${count} 個字，太短`;
  if (count > MAX_WORDS) return `有 ${count} 個字，太長`;
  if (!pronounce(text)) return '有字典查不到發音的字';
  if (UNPLEASANT.test(text)) return '命中了內容過濾的關鍵字';
  // 每一句都要有練習重點。整句都是常見音、沒有任何一個音突出的句子
  // （例如 "I'm happy to be here today." 完全沒有 th、字尾子音、連音…）
  // 拿來練發音沒有著力點，也會讓「這句在練什麼」變成空的。
  if (tagsFor(text).length === 0) return '沒有明顯的練習重點（都是很平的音）';
  return null;
}

// ─── 分類與難度 ──────────────────────────────────────────────────────────

function categorise(text) {
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(text)) return category;
  }
  return 'daily';
}

/**
 * 難度。三個訊號：句子長度、最冷僻的那個字有多冷僻、幾個字有三個音節以上。
 * 都跟「唸起來有多難」直接相關，而不是文法程度。
 */
function difficulty(text, freq) {
  const said = pronounce(text);
  const w = words(text);
  const rarest = Math.min(...said.map(({ word }) => freq.all.get(word) ?? 0));
  const longWords = said.filter(({ phones }) => syllables(phones) >= 3).length;

  if (w.length >= 11 || rarest < 15 || longWords >= 3) return 'hard';
  if (w.length <= 8 && rarest >= 60 && longWords === 0) return 'easy';
  return 'medium';
}

/**
 * focus 標籤。`phonetics.js` 只留「比一般句子明顯強」的音，
 * 所以有些句子會一個都沒有 —— 那種句子拿來練發音沒有重點，直接不收。
 */
function tagsFor(text) {
  const tags = focusTags(text);
  if (tags.length > 0) return tags;

  // 兜底：真的每個音都平庸時取密度最高的一個，至少不留空
  const scores = issueScores(text);
  if (!scores || scores.size === 0) return [];
  return [[...scores.entries()].sort((a, b) => b[1] - a[1])[0][0]];
}

// ─── 挑選 ────────────────────────────────────────────────────────────────

/**
 * 依情境、難度、練到的音平均地挑。
 *
 * 不平均挑的話會拿到一堆 medium 難度、而且全部在練同幾個音的句子 ——
 * 「多給你 v/w 的句子」就會變成「一直給你同樣那三句」。
 */
function select(candidates, existing) {
  const chosen = [];
  const perCategory = new Map();
  const perIssue = new Map();
  const perBucket = new Map();
  const seen = new Set(existing.map((s) => dedupeKey(s.text)));

  // 先算既有句子的音分布，新收的要補在缺的地方
  for (const s of existing) {
    for (const tag of s.focus) perIssue.set(tag, (perIssue.get(tag) ?? 0) + 1);
  }

  // 稀有的音優先：分數越低代表這句練到的音目前越缺
  const cost = (s) => {
    const bucket = `${s.category}/${s.difficulty}`;
    const issueLoad = Math.min(...s.focus.map((t) => perIssue.get(t) ?? 0));
    return issueLoad * 3 + (perBucket.get(bucket) ?? 0);
  };

  const pool = [...candidates];
  while (pool.length > 0) {
    pool.sort((a, b) => cost(a) - cost(b));
    const next = pool.shift();

    const key = dedupeKey(next.text);
    if (seen.has(key)) continue;
    const taken = perCategory.get(next.category) ?? 0;
    if (taken >= QUOTA) continue;

    seen.add(key);
    chosen.push(next);
    perCategory.set(next.category, taken + 1);
    const bucket = `${next.category}/${next.difficulty}`;
    perBucket.set(bucket, (perBucket.get(bucket) ?? 0) + 1);
    for (const tag of next.focus) perIssue.set(tag, (perIssue.get(tag) ?? 0) + 1);

    if (chosen.length >= QUOTA * (CATEGORY_RULES.length + 1)) break;
  }
  return chosen;
}

// ─── 主流程 ──────────────────────────────────────────────────────────────

const convert = OpenCC.Converter({ from: 'cn', to: 'twp' });

/**
 * OpenCC 轉不對的少數詞。
 *
 * 簡體的「发」對應到正體的「發」與「髮」兩個字，靠詞組判斷 ——
 * 詞組表沒收的組合（例如「被发明」）就會轉成「被髮明」。305 句裡只中一句，
 * 但那一句在畫面上就是個錯字。`test/sentences.test.js` 有一條會掃這些型樣，
 * 之後匯入時再撞到別的，補進這張表即可。
 */
const FIXES = [
  [/髮明/g, '發明'],
  [/髮現/g, '發現'],
  [/髮生/g, '發生'],
  [/髮展/g, '發展'],
  [/髮出/g, '發出'],
  [/頭發/g, '頭髮'],
];

function toTraditional(text) {
  return FIXES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), convert(text));
}

function main() {
  const write = process.argv.includes('--write');
  const retag = process.argv.includes('--retag');
  let existing = JSON.parse(readFileSync(TARGET, 'utf8'));

  if (retag) {
    // 既有 81 句的 focus 是人工標的，而人工標會出錯 —— 例如把只有 W 沒有 V 的句子
    // 標成 v_w（那句根本練不到 v／w 的分辨）。整份用同一套規則重標才一致。
    let changed = 0;
    existing = existing.map((s) => {
      const focus = tagsFor(s.text);
      if (focus.length > 0 && focus.join() !== s.focus.join()) changed += 1;
      return focus.length > 0 ? { ...s, focus } : s;
    });
    console.log(`重標既有句子：${changed} / ${existing.length} 句的 focus 有變`);
  }

  console.log(`Tatoeba 句對 ${pairs.length.toLocaleString()} 組，既有練習句 ${existing.length} 句`);

  const english = pairs.map(([, , , en]) => en);
  const freq = buildFrequency(english);

  const handwritten = loadHandwritten();
  if (handwritten.length > 0) {
    const byCategory = new Map();
    for (const s of handwritten) byCategory.set(s.category, (byCategory.get(s.category) ?? 0) + 1);
    console.log(
      `手寫句子 ${handwritten.length} 句（` +
        [...byCategory].map(([k, v]) => `${k} ${v}`).join('、') +
        '）'
    );
  }

  const candidates = [];
  const stats = { total: 0, accepted: 0, noFocus: 0 };
  const bestByKey = new Map();

  for (const [, zh, , en] of pairs) {
    stats.total += 1;
    const text = en.trim();
    if (!accept(text, freq)) continue;

    const focus = tagsFor(text);
    if (focus.length === 0) {
      stats.noFocus += 1;
      continue;
    }
    stats.accepted += 1;

    const key = dedupeKey(text);
    if (bestByKey.has(key)) continue; // 同一句英文可能對到多句中文，留第一個就好
    const entry = {
      text,
      category: categorise(text),
      difficulty: difficulty(text, freq),
      focus,
      zh: toTraditional(zh.trim()),
    };
    bestByKey.set(key, entry);
    candidates.push(entry);
  }

  if (process.env.POOL) {
    const byBucket = new Map();
    for (const c of candidates) {
      const k = `${c.category}/${c.difficulty}`;
      byBucket.set(k, (byBucket.get(k) ?? 0) + 1);
    }
    console.log('候選池分布：', [...byBucket].sort().map(([k, v]) => `${k}=${v}`).join(' '));
  }

  console.log(
    `通過清洗 ${stats.accepted.toLocaleString()} 句` +
      `（去重後 ${candidates.length.toLocaleString()}），` +
      `因為沒有明顯的練習重點而淘汰 ${stats.noFocus.toLocaleString()} 句`
  );

  // 手寫的排在前面，同樣要通過去重與配額，但難度也自動算
  const handwrittenEntries = handwritten.map((s) => ({
    text: s.text,
    category: s.category,
    difficulty: difficulty(s.text, freq),
    focus: s.focus,
  }));

  const picked = select([...handwrittenEntries, ...candidates], existing);
  const nextId = Math.max(...existing.map((s) => s.id)) + 1;
  const added = picked.map((s, i) => ({ id: nextId + i, ...s }));
  const merged = [...existing, ...added];

  report(added, merged);

  if (!write) {
    console.log('\n（試跑，沒有寫檔。要真的寫入請加 --write）');
    return;
  }
  writeFileSync(TARGET, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`\n已寫入 ${path.relative(ROOT, TARGET)}：${existing.length} → ${merged.length} 句`);
}

function report(added, merged) {
  const tally = (list, key) => {
    const counts = new Map();
    for (const s of list) {
      const values = Array.isArray(s[key]) ? s[key] : [s[key]];
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('、');
  };

  console.log(`\n新增 ${added.length} 句，合計 ${merged.length} 句`);
  console.log('  情境：', tally(merged, 'category'));
  console.log('  難度：', tally(merged, 'difficulty'));
  console.log('  練到的音：', tally(merged, 'focus'));

  // SAMPLE=40 可以看更多句，匯入前用眼睛掃一遍很值得
  const sampleSize = Number(process.env.SAMPLE ?? 12);
  console.log('\n樣本：');
  for (const s of added.slice(0, sampleSize)) {
    console.log(`  [${s.category}/${s.difficulty}] ${s.text}`);
    console.log(`     ${s.focus.join('、')}${s.zh ? `　${s.zh}` : '　（手寫，沒有中文）'}`);
  }
}

main();
