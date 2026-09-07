#!/usr/bin/env node
/**
 * 用 Gemini 在「建置期」擴充題庫。產出的 JSON 會併進 content/，
 * App 執行時仍然只讀靜態檔 —— 不會在使用者按下按鈕時呼叫 AI。
 *
 * 用法：
 *   node scripts/generate-content.mjs listening   --plan            # 現況與建議，不呼叫 API
 *   node scripts/generate-content.mjs listening   --count 20
 *   node scripts/generate-content.mjs translation --count 40
 *   node scripts/generate-content.mjs dialogue    --count 10 --category food
 *   node scripts/generate-content.mjs listening   --count 5 --dry-run
 *
 * 需要 .env 裡的 GEMINI_API_KEY（`--plan` 不用）。--dry-run 只印出結果不寫檔。
 *
 * 不指定 --category 時，**每一批都補目前最少的那個情境**（見 scarcest()）——
 * 照順序輪的話，最缺的情境要等好幾批才輪得到一次。
 *
 * 每一筆都會通過與現有內容相同的結構檢查，不合格的直接丟掉並回報原因 ——
 * 寧可少幾題，也不要把壞資料寫進題庫。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

// 情境與難度**跟 App 用同一份**（`public/lib/labels.js`）。
//
// 這裡原本自己寫死四個（work / daily / travel / interview），結果是
// **聽力與情境對話永遠生不出另外四個情境** —— 餐飲、購物、健康、學習
// 各 0 組，而設定頁那八顆情境按鈕照樣點得下去（點了會靜靜退回全部題目，
// 見 listening.js 的 `if (items.length === 0) items = raw`）。
// 句庫與中翻英是腳本匯入的、八個情境都有，所以只有這兩個模式有洞。
import { CATEGORY_LABEL, DIFFICULTY_ORDER } from '../public/lib/labels.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const MODEL = 'gemini-3.6-flash';
const BATCH = 5;                 // 一次請求產幾筆；太多會讓品質下降
const CATEGORIES = Object.keys(CATEGORY_LABEL);
const DIFFICULTIES = [...DIFFICULTY_ORDER];

const [type, ...rest] = process.argv.slice(2);
const argOf = (n, d) => { const i = rest.indexOf(n); return i >= 0 && rest[i + 1] ? rest[i + 1] : d; };
const COUNT = Number(argOf('--count', 10));
const ONLY_CATEGORY = argOf('--category', '');
const DRY_RUN = rest.includes('--dry-run');
// --plan 只看現況、不呼叫 API，所以**不需要金鑰**：先知道要補哪些情境、
// 分幾批跑，再決定要不要真的花那些呼叫
const PLAN_ONLY = rest.includes('--plan');

// ─── 各類型的 schema、提示詞與驗證 ───────────────────────────────────────
const TYPES = {
  listening: {
    file: 'listening.json',
    // **兩個鍵**：標題，以及逐字稿的前 12 個字。
    // 只看標題的話，同一段內容換個標題就進得來 —— 而重跑幾批之後，
    // 模型本來就很容易再寫出幾乎一樣的獨白（「機場報到」寫十次都很像）。
    dedupeKeys: (x) => [`title:${norm(x.title)}`, `script:${firstWords(x.transcript, 12)}`],
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              category: { type: 'string', enum: CATEGORIES },
              difficulty: { type: 'string', enum: DIFFICULTIES },
              transcript: { type: 'string' },
              questions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    question: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } },
                    answer: { type: 'integer' },
                    explain_zh: { type: 'string' },
                  },
                  required: ['question', 'options', 'answer', 'explain_zh'],
                },
              },
            },
            required: ['title', 'category', 'difficulty', 'transcript', 'questions'],
          },
        },
      },
      required: ['items'],
    },
    prompt: (n, cat) => `請產生 ${n} 組英語聽力理解練習題${cat ? `，情境限定為 ${cat}` : ''}。

每一組包含：
- title：英文標題，簡短描述情境
- category：${CATEGORIES.join(' / ')} 擇一
- difficulty：${DIFFICULTIES.join(' / ')} 擇一
- transcript：一段 40–90 字的自然英語獨白或單人對話片段，像真實情境會聽到的那樣，
  不要教科書腔。可以包含數字、時間、地點等需要聽清楚的細節。
- questions：2–3 道理解測驗，每題要有：
  - question：英文題目
  - options：正好 4 個英文選項，長度相近，錯的選項要合理（不能一眼看出是錯的）
  - answer：正解在 options 中的索引（0–3）
  - explain_zh：繁體中文解析，要引用 transcript 裡的關鍵句並解釋用法，
    不要只是把英文原句抄一遍

重要：題目與選項一律用英文，解析一律用繁體中文（台灣用語）。`,
    validate(x) {
      if (!x.title?.trim()) return '缺 title';
      if (!CATEGORIES.includes(x.category)) return `category 不合法：${x.category}`;
      if (!DIFFICULTIES.includes(x.difficulty)) return `difficulty 不合法：${x.difficulty}`;
      const words = String(x.transcript).trim().split(/\s+/).length;
      if (words < 25) return `transcript 太短（${words} 字）`;
      if (hasChinese(x.transcript)) return 'transcript 含中文';
      if (!Array.isArray(x.questions) || x.questions.length < 2) return '題數少於 2';
      for (const [i, q] of x.questions.entries()) {
        if (hasChinese(q.question)) return `Q${i + 1} 題目含中文`;
        if (!Array.isArray(q.options) || q.options.length !== 4) return `Q${i + 1} 選項不是 4 個`;
        if (q.options.some((o) => hasChinese(o))) return `Q${i + 1} 選項含中文`;
        if (new Set(q.options).size !== 4) return `Q${i + 1} 選項重複`;
        if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) return `Q${i + 1} answer 超出範圍`;
        if (!hasEnoughChinese(q.explain_zh)) return `Q${i + 1} 解析不是中文或太短`;
      }
      return null;
    },
  },

  translation: {
    file: 'translation.json',
    dedupeKeys: (x) => [`zh:${norm(x.zh)}`],
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['cloze', 'sentence'] },
              category: { type: 'string', enum: CATEGORIES },
              difficulty: { type: 'string', enum: DIFFICULTIES },
              zh: { type: 'string' },
              sentence: { type: 'string' },
              answer: { type: 'string' },
              accept: { type: 'array', items: { type: 'string' } },
              keywords: { type: 'array', items: { type: 'string' } },
              hint_zh: { type: 'string' },
              explain_zh: { type: 'string' },
            },
            required: ['type', 'category', 'difficulty', 'zh', 'answer', 'accept', 'explain_zh'],
          },
        },
      },
      required: ['items'],
    },
    prompt: (n, cat) => `請產生 ${n} 題中翻英練習${cat ? `，情境限定為 ${cat}` : ''}，兩種題型各半：

type = "cloze"（句中填空）：
- zh：繁體中文句子
- sentence：對應的英文句子，把一個關鍵字挖成三個底線 ___
- answer：該填的字
- accept：可接受的答案（含 answer 本身，以及同義的替代字）
- hint_zh：繁體中文提示，暗示但不直接講出答案
- explain_zh：繁體中文說明這個字的用法

type = "sentence"（整句翻譯）：
- zh：繁體中文句子
- answer：最自然的英文翻譯
- accept：2 個可接受的說法（含 answer）
- keywords：3–5 個一定要出現的關鍵字或片語（小寫）
- explain_zh：繁體中文說明語法重點或常見錯誤

句子要像真實會用到的，不要教科書例句。中文一律用台灣用語。`,
    validate(x) {
      if (!['cloze', 'sentence'].includes(x.type)) return `type 不合法：${x.type}`;
      if (!CATEGORIES.includes(x.category)) return `category 不合法：${x.category}`;
      if (!DIFFICULTIES.includes(x.difficulty)) return `difficulty 不合法：${x.difficulty}`;
      if (!hasChinese(x.zh)) return 'zh 不是中文';
      if (hasChinese(x.answer)) return 'answer 含中文';
      if (!Array.isArray(x.accept) || !x.accept.includes(x.answer)) return 'accept 未包含 answer';
      if (!hasEnoughChinese(x.explain_zh)) return 'explain_zh 不是中文或太短';
      if (x.type === 'cloze') {
        if (!x.sentence?.includes('___')) return 'cloze 的 sentence 沒有 ___';
        if (!x.hint_zh) return 'cloze 缺 hint_zh';
        if (!x.sentence.replace('___', x.answer).trim()) return 'cloze 填回去是空的';
      } else {
        if (!Array.isArray(x.keywords) || x.keywords.length < 2) return 'sentence 的 keywords 少於 2';
        const a = x.answer.toLowerCase();
        const missing = x.keywords.filter((k) => !a.includes(String(k).toLowerCase()));
        if (missing.length) return `keywords 不在 answer 裡：${missing.join(', ')}`;
      }
      return null;
    },
  },

  dialogue: {
    file: 'dialogues.json',
    // 標題 + 情境描述。
    //
    // **不要用第一句對白當鍵** —— 開場白是公式化的：現有的 61 段裡，
    // 「寄包裹」與「郵局寄掛號」都以 "Next please. What can I do for you?" 開頭，
    // 但那是兩段完全不同的對話。情境描述才是「這段在演什麼」。
    dedupeKeys: (x) => [`title:${norm(x.title)}`, `set:${norm(x.setting_zh)}`],
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              category: { type: 'string', enum: CATEGORIES },
              difficulty: { type: 'string', enum: DIFFICULTIES },
              setting_zh: { type: 'string' },
              your_role_zh: { type: 'string' },
              partner_role_zh: { type: 'string' },
              turns: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    speaker: { type: 'string', enum: ['partner', 'you'] },
                    en: { type: 'string' },
                    intent_zh: { type: 'string' },
                    answer: { type: 'string' },
                    accept: { type: 'array', items: { type: 'string' } },
                    keywords: { type: 'array', items: { type: 'string' } },
                    note_zh: { type: 'string' },
                  },
                  required: ['speaker'],
                },
              },
            },
            required: ['title', 'category', 'difficulty', 'setting_zh',
                       'your_role_zh', 'partner_role_zh', 'turns'],
          },
        },
      },
      required: ['items'],
    },
    prompt: (n, cat) => `請產生 ${n} 段英語情境對話練習${cat ? `，情境限定為 ${cat}` : ''}。
使用者會扮演其中一個角色，另一個角色由系統唸出來。

每一段包含：
- title：繁體中文標題
- category / difficulty
- setting_zh：繁體中文描述情境
- your_role_zh / partner_role_zh：兩個角色的中文名稱
- turns：6–9 個回合，speaker 交替出現，且必須包含 3–4 個 speaker="you" 的回合

speaker = "partner" 的回合只要：
- en：這個角色說的英文，自然口語

speaker = "you" 的回合要：
- intent_zh：用繁體中文描述「你這句話想表達什麼」，不要直接寫出英文
- answer：最自然的英文說法
- accept：2 個可接受的說法（含 answer）
- keywords：2–4 個一定要出現的關鍵字（小寫）
- note_zh：繁體中文說明用字或語法重點

對話要能接得上，前後有邏輯。中文一律用台灣用語。`,
    validate(x) {
      if (!x.title?.trim()) return '缺 title';
      if (!CATEGORIES.includes(x.category)) return `category 不合法：${x.category}`;
      if (!DIFFICULTIES.includes(x.difficulty)) return `difficulty 不合法：${x.difficulty}`;
      if (!hasChinese(x.setting_zh)) return 'setting_zh 不是中文';
      if (!Array.isArray(x.turns) || x.turns.length < 4) return '回合數少於 4';
      const yours = x.turns.filter((t) => t.speaker === 'you');
      if (yours.length < 2) return `使用者台詞只有 ${yours.length} 句`;
      for (const [i, t] of x.turns.entries()) {
        if (t.speaker === 'partner') {
          if (!t.en?.trim()) return `turn ${i} partner 缺 en`;
          if (hasChinese(t.en)) return `turn ${i} partner 的 en 含中文`;
        } else if (t.speaker === 'you') {
          if (!hasChinese(t.intent_zh)) return `turn ${i} intent_zh 不是中文`;
          if (!t.answer?.trim() || hasChinese(t.answer)) return `turn ${i} answer 有問題`;
          if (!Array.isArray(t.accept) || !t.accept.includes(t.answer)) return `turn ${i} accept 未含 answer`;
          if (!Array.isArray(t.keywords) || t.keywords.length < 1) return `turn ${i} 缺 keywords`;
          const a = t.answer.toLowerCase();
          const missing = t.keywords.filter((k) => !a.includes(String(k).toLowerCase()));
          if (missing.length) return `turn ${i} keywords 不在 answer 裡：${missing.join(', ')}`;
          if (!hasEnoughChinese(t.note_zh)) return `turn ${i} note_zh 不是中文或太短`;
        } else return `turn ${i} speaker 不合法`;
      }
      return null;
    },
  },
};

/**
 * 一批產出裡哪些收得下來。**這是題庫的守門員** ——
 * 壞資料寫進 content/ 之後就會出現在使用者眼前（而且是靜悄悄的：
 * 一題四個選項少一個、解析是英文原句抄一遍，都不會有任何錯誤訊息）。
 *
 * 抽成純函式是為了測得到：真的呼叫模型要金鑰、要配額，而且回來的東西每次不一樣，
 * 所以驗收規則不能只靠「跑一次看看」。`test/content-generation.test.js` 餵假資料進來。
 *
 * `seen` **會被就地更新**（收下的鍵加進去），所以同一批裡的重複也擋得掉 ——
 * 模型在同一次回應裡寫出兩段幾乎一樣的東西是常態。
 *
 * @param {object} spec TYPES 裡的一項
 * @param {Array<object>} items 模型這一批回的東西
 * @param {Set<string>} seen 已經見過的 dedupe 鍵
 * @param {number} limit 最多收幾筆（還差幾筆就只收幾筆）
 * @returns {{accepted: Array<object>, rejected: Array<{item: object, problem: string}>}}
 */
export function sift(spec, items, seen, limit = Infinity) {
  const accepted = [];
  const rejected = [];

  for (const item of items ?? []) {
    if (accepted.length >= limit) break;

    const problem = spec.validate(item);
    if (problem) { rejected.push({ item, problem }); continue; }

    const keys = spec.dedupeKeys(item);
    if (keys.some((k) => seen.has(k))) {
      rejected.push({ item, problem: '與現有內容重複' });
      continue;
    }

    for (const k of keys) seen.add(k);
    accepted.push(item);
  }

  return { accepted, rejected };
}

/** 比對用的正規化：大小寫、空白與標點都不算差別。 */
function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
}

/** 前 n 個字（正規化過）。近似重複的判斷靠它。 */
function firstWords(s, n) {
  return norm(s).split(' ').slice(0, n).join(' ');
}

function hasChinese(s) { return /[一-鿿]/.test(String(s ?? '')); }
// 目的是擋掉「把英文原句抄一遍」這種等於沒解析的內容。
// 門檻不能太高 —— 「grab a coffee 比 buy a coffee 自然。」只有 3 個中文字，
// 但那是合理的解析。兩個字足以區分「有中文說明」與「純英文引用」。
function hasEnoughChinese(s) { return (String(s ?? '').match(/[一-鿿]/g) ?? []).length >= 2; }

// 驗證邏輯要能單獨測試，所以匯出，並且只有直接執行時才跑主流程
export { TYPES, CATEGORIES, DIFFICULTIES, hasChinese, hasEnoughChinese, norm, firstWords };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) { /* 被 import 時不執行下面的流程 */ }
else await main();

async function main() {
const spec = TYPES[type];
if (!spec) {
  console.error(
    `用法：node scripts/generate-content.mjs <${Object.keys(TYPES).join('|')}>` +
    ' [--plan] [--count N] [--category X] [--dry-run]'
  );
  process.exit(1);
}

const target = path.join(ROOT, 'content', spec.file);
const existing = JSON.parse(fs.readFileSync(target, 'utf8'));

// --plan 先跑：它不呼叫 API，所以**金鑰的檢查要在它後面** ——
// 「要補哪些情境」是決定要不要花那些呼叫之前就該看得到的東西
if (PLAN_ONLY) {
  printPlan(type, spec, existing);
  process.exit(0);
}

if (!process.env.GEMINI_API_KEY?.trim()) {
  console.error('找不到 GEMINI_API_KEY。請在專案根目錄的 .env 填入金鑰，或用設定頁填。');
  process.exit(1);
}

// 多個鍵（標題、逐字稿開頭…）都算「見過了」，見各 type 的 dedupeKeys
const seen = new Set(existing.flatMap(spec.dedupeKeys));
const tally = countByCategory(existing);
console.log(`現有 ${existing.length} 筆，目標再產生 ${COUNT} 筆。`);
console.log(`目前的情境分佈：${describeTally(tally)}\n`);

const ai = new GoogleGenAI({});
const accepted = [];
const rejected = [];
let round = 0;

while (accepted.length < COUNT && round < Math.ceil(COUNT / BATCH) + 3) {
  round++;
  const want = Math.min(BATCH, COUNT - accepted.length);
  // **每一批都補目前最少的那個情境**（含這一輪已經收下的）。
  // 照順序輪的話，0 組的那個情境要等好幾批才輪得到一次，而那正是要補的
  const cat = ONLY_CATEGORY || scarcest(tally);
  process.stdout.write(`第 ${round} 批（${cat}，${want} 筆）… `);

  let items;
  try {
    const interaction = await ai.interactions.create({
      model: MODEL,
      input: [{ type: 'text', text: spec.prompt(want, cat) }],
      response_format: { type: 'text', mime_type: 'application/json', schema: spec.schema },
    });
    items = JSON.parse(interaction.output_text).items ?? [];
  } catch (err) {
    console.log(`失敗：${err.message}`);
    continue;
  }

  const batch = sift(spec, items, seen, COUNT - accepted.length);
  for (const item of batch.accepted) {
    accepted.push(item);
    tally[item.category] = (tally[item.category] ?? 0) + 1;
  }
  rejected.push(...batch.rejected);
  console.log(`收下 ${batch.accepted.length} / ${items.length}（累計 ${accepted.length}/${COUNT}）`);
}

console.log(`\n通過 ${accepted.length} 筆，退掉 ${rejected.length} 筆。`);
if (rejected.length) {
  console.log('退件原因：');
  const counts = {};
  for (const r of rejected) counts[r.problem] = (counts[r.problem] ?? 0) + 1;
  for (const [reason, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}×  ${reason}`);
  }
}

if (accepted.length === 0) {
  // 「一筆都沒收下」有兩種原因，處理方式完全不同：
  //   呼叫失敗 → 金鑰、配額或網路的問題，重跑就好（exit 1，腳本串起來時看得出來）
  //   全被退件 → 是內容品質的問題，重跑只會再燒一次配額，要先看退件原因
  console.log(rejected.length === 0
    ? '\n沒有可寫入的內容 —— 每一批呼叫都失敗了（金鑰、配額或網路）。'
    : '\n沒有可寫入的內容 —— 產出來的每一筆都被退件了。先看上面的退件原因。');
  process.exit(1);
}

if (DRY_RUN) {
  console.log('\n--dry-run：以下是產生的內容，未寫入檔案\n');
  console.log(JSON.stringify(accepted, null, 2).slice(0, 4000));
  process.exit(0);
}

const merged = mergeIntoExisting(existing, accepted);
fs.writeFileSync(target, JSON.stringify(merged, null, 2) + '\n');
console.log(`\n已寫入 ${spec.file}：${existing.length} → ${merged.length} 筆。`);
console.log(`情境分佈：${describeTally(countByCategory(merged))}`);
console.log('接下來：npm test（資料測試會把新內容一起驗一次）。');
}

/**
 * 把收下來的東西接在現有內容後面，並補上 id。
 *
 * **id 一定要接在現有的最大值後面**，不是 `existing.length + 1` ——
 * 中間刪過幾筆的話那樣會撞號，而撞號的症狀是「練習紀錄指到別的題目」
 * （紀錄存的是 id）。純函式，`test/content-generation.test.js` 釘住。
 */
export function mergeIntoExisting(existing, accepted) {
  let nextId = Math.max(0, ...existing.map((x) => Number(x.id) || 0)) + 1;
  // id 放在最前面，讀 JSON 的人一眼看得到是第幾筆
  return [...existing, ...accepted.map((x) => ({ id: nextId++, ...x }))];
}

// ─── 現況與建議（--plan）─────────────────────────────────────────────────

function countByCategory(items) {
  const tally = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const x of items) tally[x.category] = (tally[x.category] ?? 0) + 1;
  return tally;
}

function describeTally(tally) {
  return Object.entries(tally).map(([c, n]) => `${CATEGORY_LABEL[c] ?? c} ${n}`).join('・');
}

/** 目前最少的情境。同樣少的話照 CATEGORIES 的順序 —— 要可重現。 */
function scarcest(tally) {
  return CATEGORIES.reduce((a, b) => ((tally[b] ?? 0) < (tally[a] ?? 0) ? b : a), CATEGORIES[0]);
}

/**
 * 印出「現在有什麼、還缺什麼、要跑幾批」。**不呼叫 API**。
 *
 * 為什麼值得有：生成是要花錢也要花時間的（一批 5 筆，重跑幾輪），
 * 而「哪個情境是 0」這種事看檔案才看得出來 —— 用猜的就會補在已經很多的地方。
 */
function printPlan(kind, spec, existing) {
  const tally = countByCategory(existing);
  const per = Object.values(tally);
  const most = Math.max(...per);
  const target = Number(argOf('--target', String(most)));

  console.log(`\n${spec.file}：現有 ${existing.length} 筆`);
  if (kind === 'listening') {
    const qs = existing.reduce((n, x) => n + (x.questions?.length ?? 0), 0);
    console.log(`（${qs} 題，平均一組 ${(qs / Math.max(1, existing.length)).toFixed(1)} 題）`);
  }
  console.log(`情境分佈：${describeTally(tally)}`);
  console.log(`難度分佈：${DIFFICULTIES.map((d) =>
    `${d} ${existing.filter((x) => x.difficulty === d).length}`).join('・')}`);

  const gaps = CATEGORIES.filter((c) => tally[c] < target)
    .map((c) => ({ c, need: target - tally[c] }))
    .sort((a, b) => b.need - a.need);

  if (gaps.length === 0) {
    console.log(`\n八個情境都到 ${target} 筆了，不必補。`);
    return;
  }

  console.log(`\n補到每個情境 ${target} 筆的話還缺 ${gaps.reduce((n, g) => n + g.need, 0)} 筆：`);
  for (const { c, need } of gaps) {
    console.log(`  ${(CATEGORY_LABEL[c] ?? c).padEnd(5, '　')} 還缺 ${String(need).padStart(3)} 筆` +
      `  →  node scripts/generate-content.mjs ${kind} --count ${need} --category ${c}`);
  }
  console.log(
    '\n一批 5 筆，退件會自動重試（上限 = 批數 + 3）。建議一個情境一次跑，' +
    '跑完看退件原因再決定下一個。\n' +
    '不指定 --category 就會自動每批補最少的那個情境。\n' +
    '先加 --dry-run 看一批的品質，覺得可以再真的寫進去。'
  );
}
