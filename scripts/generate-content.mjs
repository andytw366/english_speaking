#!/usr/bin/env node
/**
 * 用 Gemini 在「建置期」擴充題庫。產出的 JSON 會併進 content/，
 * App 執行時仍然只讀靜態檔 —— 不會在使用者按下按鈕時呼叫 AI。
 *
 * 用法：
 *   node scripts/generate-content.mjs listening   --count 20
 *   node scripts/generate-content.mjs translation --count 40
 *   node scripts/generate-content.mjs dialogue    --count 10 --category work
 *   node scripts/generate-content.mjs listening   --count 5 --dry-run
 *
 * 需要 .env 裡的 GEMINI_API_KEY。--dry-run 只印出結果不寫檔。
 *
 * 每一筆都會通過與現有內容相同的結構檢查，不合格的直接丟掉並回報原因 ——
 * 寧可少幾題，也不要把壞資料寫進題庫。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const MODEL = 'gemini-3.6-flash';
const BATCH = 5;                 // 一次請求產幾筆；太多會讓品質下降
const CATEGORIES = ['work', 'daily', 'travel', 'interview'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

const [type, ...rest] = process.argv.slice(2);
const argOf = (n, d) => { const i = rest.indexOf(n); return i >= 0 && rest[i + 1] ? rest[i + 1] : d; };
const COUNT = Number(argOf('--count', 10));
const ONLY_CATEGORY = argOf('--category', '');
const DRY_RUN = rest.includes('--dry-run');

// ─── 各類型的 schema、提示詞與驗證 ───────────────────────────────────────
const TYPES = {
  listening: {
    file: 'listening.json',
    dedupeBy: (x) => x.title.toLowerCase(),
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
    dedupeBy: (x) => x.zh,
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
    dedupeBy: (x) => x.title,
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

function hasChinese(s) { return /[一-鿿]/.test(String(s ?? '')); }
// 目的是擋掉「把英文原句抄一遍」這種等於沒解析的內容。
// 門檻不能太高 —— 「grab a coffee 比 buy a coffee 自然。」只有 3 個中文字，
// 但那是合理的解析。兩個字足以區分「有中文說明」與「純英文引用」。
function hasEnoughChinese(s) { return (String(s ?? '').match(/[一-鿿]/g) ?? []).length >= 2; }

// 驗證邏輯要能單獨測試，所以匯出，並且只有直接執行時才跑主流程
export { TYPES, hasChinese, hasEnoughChinese };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) { /* 被 import 時不執行下面的流程 */ }
else await main();

async function main() {
const spec = TYPES[type];
if (!spec) {
  console.error(`用法：node scripts/generate-content.mjs <${Object.keys(TYPES).join('|')}> [--count N] [--category X] [--dry-run]`);
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY?.trim()) {
  console.error('找不到 GEMINI_API_KEY。請在專案根目錄的 .env 填入金鑰，或用設定頁填。');
  process.exit(1);
}

const target = path.join(ROOT, 'content', spec.file);
const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
const seen = new Set(existing.map(spec.dedupeBy));
console.log(`現有 ${existing.length} 筆，目標再產生 ${COUNT} 筆。\n`);

const ai = new GoogleGenAI({});
const accepted = [];
const rejected = [];
let round = 0;

while (accepted.length < COUNT && round < Math.ceil(COUNT / BATCH) + 3) {
  round++;
  const want = Math.min(BATCH, COUNT - accepted.length);
  const cat = ONLY_CATEGORY || CATEGORIES[round % CATEGORIES.length];
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

  let ok = 0;
  for (const item of items) {
    const problem = spec.validate(item);
    if (problem) { rejected.push({ item, problem }); continue; }
    const key = spec.dedupeBy(item);
    if (seen.has(key)) { rejected.push({ item, problem: '與現有內容重複' }); continue; }
    seen.add(key);
    accepted.push(item);
    ok++;
    if (accepted.length >= COUNT) break;
  }
  console.log(`收下 ${ok} / ${items.length}（累計 ${accepted.length}/${COUNT}）`);
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

if (accepted.length === 0) { console.log('\n沒有可寫入的內容。'); process.exit(0); }

if (DRY_RUN) {
  console.log('\n--dry-run：以下是產生的內容，未寫入檔案\n');
  console.log(JSON.stringify(accepted, null, 2).slice(0, 4000));
  process.exit(0);
}

let nextId = Math.max(0, ...existing.map((x) => Number(x.id) || 0)) + 1;
const merged = [...existing, ...accepted.map((x) => ({ id: nextId++, ...x }))];
fs.writeFileSync(target, JSON.stringify(merged, null, 2) + '\n');
console.log(`\n已寫入 ${spec.file}：${existing.length} → ${merged.length} 筆。`);
}
