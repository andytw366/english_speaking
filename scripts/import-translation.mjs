// 從 Tatoeba 語料匯入中翻英題目（`type: "sentence"`）。
//
//   node scripts/import-translation.mjs           # 試跑，只印統計與樣本，不寫檔
//   node scripts/import-translation.mjs --write   # 真的寫進 content/translation.json
//
// 為什麼可以離線做：Tatoeba 給的本來就是**中英句對**，而中翻英要的正好是
// 「一句中文 + 可接受的英文答案」。跟讀句庫（import-sentences.mjs）只用到英文那一半，
// 中文那一半在這裡才真正派上用場。
//
// ─── 這支腳本存在的真正理由：accept[] ──────────────────────────────────────
//
// 中翻英最難的不是出題，是**批改**。同一句中文有很多種正確的英文說法，
// 而 `lib/grade.js` 只認 `accept[]` 裡的字串（完全相符）或 `keywords` 全中（意思對了）。
// 手寫的 118 題每題只填得出 2 個 accept，剩下的正確答案一律被判成「再想想」。
//
// Tatoeba 的結構剛好解決這件事：同一句中文常常對到好幾句英文
// （「我們試試看！」有 "Let's try it." / "Let's have a try." / "Let's give it a try." / "Let's try!"），
// 而那些就是**真人寫的、互相對等的翻譯**。把它們整組收進 accept[]，
// 使用者寫出其中任何一種都算完全正確 —— 這是手寫題目補不出來的東西。
//
// keywords 也跟著變客觀：只收「每一個 accept 都出現」的實詞。
// 某個字只出現在其中一種說法裡，就代表它不是必要的，不能拿來當扣分的理由。
//
// 資料來源：Tatoeba（https://tatoeba.org/），授權 CC BY 2.0 FR。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import pairs from 'tatoeba-sentence-pairs-in-mandarin-chinese-english';

import { tokens } from '../public/lib/grade.js';
import {
  acceptSentence, buildFrequency, categorise, dedupeKey, difficulty, lower,
  toTraditional,
} from './corpus.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'content', 'translation.json');

/**
 * 英文答案的長度。
 *
 * 跟跟讀句庫（5–13）不一樣的地方在下限：中翻英是用打的，不必一口氣唸完，
 * 所以上限可以放寬到 14；但「Thank you.」這種三個字的句子翻起來沒有練到什麼，
 * 下限反而更該守住。
 */
const BOUNDS = { minWords: 5, maxWords: 14 };

/**
 * 每個情境要收幾題。
 *
 * 現有的手寫題目是 279 題（161 填空 + 118 中翻英）。四個情境各 300 題之後
 * 總量約 1,400 題 —— 照每天 20 題算，兩個多月不會重複，而且因為是依
 * 情境 × 難度平均挑的，不會出現「今天全是簡單的日常句」。
 *
 * 跟 `import-sentences.mjs` 的 QUOTA 一樣，這是「這個情境**總共**要幾題」，
 * 不是「這一次要收幾題」—— 從既有題數起算，重跑才不會每次都再疊一輪上去。
 */
export const QUOTA = 300;

/** 中文題目的長度（字元）。太短沒東西可翻，太長變成考閱讀。 */
const ZH_MIN = 5;
const ZH_MAX = 28;

/**
 * 中文側的清洗。
 *
 * 英文那半已經被 `acceptSentence()` 篩過，但中文是**題目本身**，
 * 使用者第一眼看到的就是它 —— 簡繁轉換的錯字、半形逗號、沒收乾淨的
 * 「湯姆」，在畫面上全都是瑕疵。
 */
const ZH_CLEAN = /^[㐀-鿿、。，？！；：…「」]+$/;

/** Tatoeba 的佔位人名。英文側靠詞頻擋得掉，中文側要自己列。 */
const ZH_NAMES = /(湯姆|汤姆|瑪麗|玛丽|瑪麗亞|傑克|約翰|鮑勃|愛麗絲|肯|波士頓|芝加哥)/;

/** 結尾一定要有標點。沒有的多半是被從長句裡切出來的片段。 */
const ZH_END = /[。？！]$/;

/**
 * 承接上文的開頭 —— 中文側的 `LEAD_CONJ`。
 *
 * Tatoeba 的中文有些是從長句切出來的，主詞掉在前一句：
 * 「是我最喜歡的書之一。」文法上不算錯，但單獨當題目看，
 * 使用者不知道那個「是」的主詞是什麼，翻出來的英文自然對不上參考答案。
 */
const ZH_LEAD = /^(是|也|而|就|但|不過|所以|然後|因為|於是|接著|另外|況且|再說|可是|然而)/;

/**
 * 不算「實詞」的字。
 *
 * keywords 是拿來判斷「意思有沒有到」的，所以只收帶意義的字 ——
 * 冠詞、be 動詞、代名詞在每一句裡都有，收進去等於沒有篩選作用，
 * 反而會把 keywords 的名額佔滿。
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might', 'must', 'to', 'of', 'in', 'on', 'at', 'for',
  'with', 'by', 'from', 'as', 'and', 'or', 'but', 'if', 'that', 'this', 'these',
  'those', 'it', "it's", 'its', 'i', "i'm", "i've", "i'll", "i'd", 'you', "you're",
  "you've", "you'll", 'your', 'we', "we're", 'our', 'they', "they're", 'their',
  'me', 'my', 'us', 'them', 'not', "don't", "doesn't", "didn't", "can't", "won't",
  'there', 'here', 'so', 'too', 'very', 'just', 'now', 'then', 'up', 'out',
]);

/** keywords 最多幾個。全部收的話等於逐字比對，「換句話說」一定被判錯。 */
const MAX_KEYWORDS = 4;

/** 一題至少要有這麼多個 keywords，否則批改太寬鬆（隨便寫都算「意思對了」）。 */
const MIN_KEYWORDS = 2;

/**
 * 這一組翻譯的必要實詞：**每一個** accept 都出現的字。
 *
 * 這條規則是這支腳本的核心。`grade()` 判「意思對了」的條件是 keywords 全中，
 * 所以只要有一個 keyword 不是每種說法都有，就會出現
 * 「照著 accept[2] 寫，卻被判成再想想」——
 * 使用者看得到那個答案在「也可以說」裡面，卻拿到 ❌。
 *
 * 交集之後再依「在語料裡越少見排越前」取前幾個：越少見的字越能代表這句的意思
 * （make / take / thing 到處都是，reservation / refund 才是這句在考的東西）。
 */
export function keywordsFor(accepts, freq) {
  // ⚠ 一定要用 `grade.js` 自己的 tokens()，不能用 corpus.js 的 lower()。
  //
  // 兩邊對連字號的處理不一樣：lower() 把 `ten-minute` 拆成 ten / minute，
  // 但真正批改的 tokens() 留成一個 `ten-minute`。用 lower() 算出來的 keyword
  // 「ten」在批改時**永遠比對不到**，那一題就再也判不出「意思對了」——
  // 而且畫面上只會說「少了這些關鍵用字：ten」，看起來像使用者漏字。
  // 匯入時就踩過一次，2,159 題裡中了 19 題。
  const sets = accepts.map((a) => new Set(tokens(a)));
  const shared = [...sets[0]].filter((w) => sets.every((s) => s.has(w)));

  const first = tokens(accepts[0]);
  return shared
    .filter((w) => !STOPWORDS.has(w) && w.length > 1)
    .sort((a, b) => (freq.all.get(a) ?? 0) - (freq.all.get(b) ?? 0))
    .slice(0, MAX_KEYWORDS)
    // 依在答案裡的順序排回去，這樣「還少了：」的提示讀起來跟句子一致
    .sort((a, b) => first.indexOf(a) - first.indexOf(b));
}

/**
 * 挑一句當 `answer`（顯示在「參考答案」的那一句）。
 *
 * 用字越常見的越適合當參考答案 —— 其他說法照樣算對，但擺在最前面的
 * 那一句應該是最好學的那一種，不是最刁鑽的那一種。同分時取短的。
 */
function pickAnswer(accepts, freq) {
  const score = (s) => {
    const w = lower(s);
    const rarest = Math.min(...w.map((x) => freq.all.get(x) ?? 0));
    return { rarest, length: w.length };
  };
  return [...accepts].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    return sb.rarest - sa.rarest || sa.length - sb.length;
  })[0];
}

function zhProblem(zh) {
  if (!ZH_CLEAN.test(zh)) return 'clean';
  if (!ZH_END.test(zh)) return 'end';
  if (zh.length < ZH_MIN || zh.length > ZH_MAX) return 'length';
  if (ZH_NAMES.test(zh)) return 'name';
  if (ZH_LEAD.test(zh)) return 'lead';
  return null;
}

/**
 * 依情境 × 難度平均地挑，並且優先收 accept 多的題目。
 *
 * 「accept 多的優先」是這裡跟 `import-sentences.mjs` 的 `select()` 最大的差別：
 * 一題有 4 種說法，代表使用者怎麼寫都不容易被誤判 —— 那正是中翻英最需要的。
 * 只有一種說法的題目照樣收，但排在後面。
 */
export function select(candidates, existing) {
  const chosen = [];
  const perCategory = new Map();
  const perBucket = new Map();
  const seen = new Set(existing.map((x) => dedupeKey(x.answer)));
  const seenZh = new Set(existing.map((x) => x.zh));

  // QUOTA 從既有題數起算（見 import-sentences.mjs 踩過的那個坑：
  // 從 0 起算的話，題庫滿了再跑一次照樣加滿一輪，總量安靜地變成兩倍）
  for (const x of existing) {
    perCategory.set(x.category, (perCategory.get(x.category) ?? 0) + 1);
    const bucket = `${x.category}/${x.difficulty}`;
    perBucket.set(bucket, (perBucket.get(bucket) ?? 0) + 1);
  }

  const categories = [...new Set(candidates.map((x) => x.category))];
  const room = () => categories.reduce(
    (n, c) => n + Math.max(0, QUOTA - (perCategory.get(c) ?? 0)), 0);

  // 分數越低越先收：說法越多越好，同一個 情境/難度 已經收越多的越後面
  const cost = (x) => (perBucket.get(`${x.category}/${x.difficulty}`) ?? 0) - x.accept.length * 20;

  const pool = [...candidates];
  while (pool.length > 0 && room() > 0) {
    pool.sort((a, b) => cost(a) - cost(b));
    const next = pool.shift();

    const key = dedupeKey(next.answer);
    if (seen.has(key) || seenZh.has(next.zh)) continue;
    const taken = perCategory.get(next.category) ?? 0;
    if (taken >= QUOTA) continue;

    seen.add(key);
    seenZh.add(next.zh);
    chosen.push(next);
    perCategory.set(next.category, taken + 1);
    const bucket = `${next.category}/${next.difficulty}`;
    perBucket.set(bucket, (perBucket.get(bucket) ?? 0) + 1);
  }
  return chosen;
}

function main() {
  const write = process.argv.includes('--write');
  const existing = JSON.parse(readFileSync(TARGET, 'utf8'));

  console.log(`Tatoeba 句對 ${pairs.length.toLocaleString()} 組，既有題目 ${existing.length} 題`);

  const freq = buildFrequency(pairs.map(([, , , en]) => en));

  // 依中文分組：同一句中文的所有英文翻譯要收在一起，那就是 accept[]
  const byZh = new Map();
  const stats = { total: 0, zhRejected: 0, enRejected: 0 };

  for (const [, zhRaw, , enRaw] of pairs) {
    stats.total += 1;
    const zh = toTraditional(zhRaw.trim());
    if (zhProblem(zh)) {
      stats.zhRejected += 1;
      continue;
    }
    const en = enRaw.trim();
    if (!acceptSentence(en, freq, BOUNDS)) {
      stats.enRejected += 1;
      continue;
    }
    if (!byZh.has(zh)) byZh.set(zh, new Map());
    // 同一句英文可能重複出現（大小寫、標點不同），用正規化後的形式去重
    byZh.get(zh).set(dedupeKey(en), en);
  }

  const candidates = [];
  let noKeywords = 0;
  for (const [zh, enMap] of byZh) {
    const all = [...enMap.values()];
    const answer = pickAnswer(all, freq);
    // answer 排第一：前端的「參考答案」與逐字對照用的是 accept[0]／answer
    const accept = [answer, ...all.filter((x) => x !== answer)];

    const keywords = keywordsFor(accept, freq);
    if (keywords.length < MIN_KEYWORDS) {
      // 幾種說法之間沒有共通的實詞，代表它們差太多 ——
      // 這種題目批改一定會出事，寧可不收
      noKeywords += 1;
      continue;
    }

    candidates.push({
      type: 'sentence',
      category: categorise(answer),
      difficulty: difficulty(answer, freq),
      zh,
      answer,
      accept,
      keywords,
      source: 'tatoeba',
    });
  }

  console.log(
    `中文側淘汰 ${stats.zhRejected.toLocaleString()} 組、英文側淘汰 ${stats.enRejected.toLocaleString()} 組，` +
      `剩下 ${byZh.size.toLocaleString()} 句不重複的中文；` +
      `其中 ${noKeywords.toLocaleString()} 句因為各種說法沒有共通的實詞而不收`
  );

  const picked = select(candidates, existing);
  const nextId = Math.max(...existing.map((x) => x.id)) + 1;
  const added = picked.map((x, i) => ({ id: nextId + i, ...x }));
  const merged = [...existing, ...added];

  report(added, merged);

  if (!write) {
    console.log('\n（試跑，沒有寫檔。要真的寫入請加 --write）');
    return;
  }
  writeFileSync(TARGET, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`\n已寫入 ${path.relative(ROOT, TARGET)}：${existing.length} → ${merged.length} 題`);
}

function report(added, merged) {
  const tally = (list, key) => {
    const counts = new Map();
    for (const x of list) counts.set(x[key], (counts.get(x[key]) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('、');
  };

  console.log(`\n新增 ${added.length} 題，合計 ${merged.length} 題`);
  console.log('  題型：', tally(merged, 'type'));
  console.log('  情境：', tally(merged, 'category'));
  console.log('  難度：', tally(merged, 'difficulty'));

  if (added.length > 0) {
    const acceptCounts = added.map((x) => x.accept.length);
    const avg = acceptCounts.reduce((a, b) => a + b, 0) / acceptCounts.length;
    console.log(
      `  可接受的說法：平均 ${avg.toFixed(2)} 種（最多 ${Math.max(...acceptCounts)} 種、` +
        `只有一種的 ${acceptCounts.filter((n) => n === 1).length} 題）`
    );
  }

  // SAMPLE=40 可以看更多題，匯入前用眼睛掃一遍很值得
  const sampleSize = Number(process.env.SAMPLE ?? 10);
  console.log('\n樣本：');
  for (const x of added.slice(0, sampleSize)) {
    console.log(`  [${x.category}/${x.difficulty}] ${x.zh}`);
    console.log(`     ${x.answer}`);
    if (x.accept.length > 1) console.log(`     也可以：${x.accept.slice(1).join(' ／ ')}`);
    console.log(`     關鍵字：${x.keywords.join('、')}`);
  }
}

// 被 test/translation.test.js import 時不要跑匯入流程（它只要 select() 與 keywordsFor()）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
