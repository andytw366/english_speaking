// 從 Tatoeba 語料匯入練習句，自動標 focus 與難度。
//
//   node scripts/import-sentences.mjs            # 試跑，只印統計與樣本，不寫檔
//   node scripts/import-sentences.mjs --write    # 真的寫進 content/sentences.json
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

import { focusTags, issueScores, pronounce } from './phonetics.js';
import {
  CLEAN, UNPLEASANT, acceptSentence, buildFrequency, categorise, dedupeKey,
  difficulty, toTraditional, words,
} from './corpus.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'content', 'sentences.json');
const HANDWRITTEN_DIR = path.join(ROOT, 'data');

/** 一句練習句的長度。太短練不到連音，太長一口氣唸不完、錄音也容易中斷。 */
const MIN_WORDS = 5;
const MAX_WORDS = 13;
const BOUNDS = { minWords: MIN_WORDS, maxWords: MAX_WORDS };

/**
 * 每個情境要收到幾句。
 *
 * 250 句大約是「每天練 5～10 句、兩三個月不會重複」的量。再多其實也收得到
 * （候選池有一萬四千句），但每一句都會被抽到 —— 多不等於好。
 */
export const QUOTA = 250;


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
export function select(candidates, existing) {
  const chosen = [];
  const perCategory = new Map();
  const perIssue = new Map();
  const perBucket = new Map();
  const seen = new Set(existing.map((s) => dedupeKey(s.text)));

  // 先算既有句子的音分布，新收的要補在缺的地方
  for (const s of existing) {
    for (const tag of s.focus) perIssue.set(tag, (perIssue.get(tag) ?? 0) + 1);
  }

  // QUOTA 是「這個情境總共要幾句」，不是「這一次要收幾句」——
  // perCategory 從既有句數起算，重跑才不會每次都再疊 250 句上去。
  // （之前是從 0 起算：句庫已經滿了，再跑一次照樣加滿，daily 會變成 528 句。
  //   而句子有去重，所以症狀不是壞掉，是句庫安靜地膨脹到兩倍。）
  for (const s of existing) {
    perCategory.set(s.category, (perCategory.get(s.category) ?? 0) + 1);
  }
  // 每個情境還缺幾句。全滿的時候要立刻停 —— 不然每一輪都會把整個候選池
  // （一萬五千句）重排一次卻一句都收不到。
  const categories = [...new Set(candidates.map((s) => s.category))];
  const room = () => categories.reduce(
    (n, c) => n + Math.max(0, QUOTA - (perCategory.get(c) ?? 0)), 0);

  // 稀有的音優先：分數越低代表這句練到的音目前越缺
  const cost = (s) => {
    const bucket = `${s.category}/${s.difficulty}`;
    const issueLoad = Math.min(...s.focus.map((t) => perIssue.get(t) ?? 0));
    return issueLoad * 3 + (perBucket.get(bucket) ?? 0);
  };

  const pool = [...candidates];
  while (pool.length > 0 && room() > 0) {
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
  }
  return chosen;
}

// ─── 主流程 ──────────────────────────────────────────────────────────────


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
    if (!acceptSentence(text, freq, BOUNDS)) continue;

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

// 被 test/sentences.test.js import 時不要跑匯入流程（它只要 select()）。
// Node 20 沒有 import.meta.main，所以比對執行的檔名。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
