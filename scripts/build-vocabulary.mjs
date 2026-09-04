#!/usr/bin/env node
/**
 * 從 ECDICT 產生分級單字庫。
 *
 * ECDICT（https://github.com/skywind3000/ECDICT，MIT 授權）收錄約 77 萬筆
 * 英漢詞條，含 IPA 音標、中文釋義、詞性、考試標籤與語料庫詞頻。
 * 這個腳本把它篩選成依詞頻分級的學習用卡片。
 *
 * 用法：
 *   node scripts/build-vocabulary.mjs [--csv <路徑>] [--total 10000] [--band 1000] [--out <目錄>]
 *
 * 沒給 --csv 就會自動下載（約 63 MB）。
 * 產出兩種切法，同一批字：
 *   band-01.json … band-NN.json  依詞頻切的級距（第 1–1,000 常用…）
 *   tier-1.json … tier-6.json    依難度切的分級（國中／高中／四級…，見 vocab-levels.js）
 *   tier-map.json                id → 第幾級的對照表，讓「各級進度」不必載入全部字庫
 *   index.json                   牌組目錄，App 的切換畫面讀這一份
 *
 * 兩種切法都留著是刻意的：詞頻級距是既有使用者的進度所在，難度分級才是拿來
 * 選「我要練哪一級」的。同一個字在兩種牌組裡是**同一份複習進度**（見下面的 keyspace）。
 *
 * 這是「建置期」腳本，不是執行期 —— App 跑起來只讀產出的 JSON。
 *
 * ⚠️ `curated.json` 是**手寫的**，不由這支腳本產生。所以這裡只刪自己產生的檔案，
 * 不能整個目錄砍掉重建（原本的 `rmSync(OUT_DIR)` 會把它一起刪掉，
 * 而 index.json 少了 curated 那一項，App 的預設牌組就載不到）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as OpenCC from 'opencc-js';

import { TIERS, tierFor } from './vocab-levels.js';

// ECDICT 的釋義是簡體，轉成台灣正體（twp 會一併做詞彙轉換，例如 想象→想像）
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_URL = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const TOTAL = Number(argOf('--total', 10000));
const BAND_SIZE = Number(argOf('--band', 1000));
const CSV_PATH = argOf('--csv', path.join(ROOT, 'ecdict.csv'));
// --out 是為了能先產到暫存目錄跟現有資料對照，確認 band 的字沒有跑掉再覆蓋
// —— band 的 id 就是使用者的複習進度鍵，換掉等於把進度洗掉。
const OUT_DIR = path.resolve(argOf('--out', path.join(ROOT, 'content', 'vocabulary')));

// ─── CSV 解析 ────────────────────────────────────────────────────────────
// 欄位裡有逗號與跳脫的引號，不能用 split(',')。
function* parseCsv(text) {
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      yield row; row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field || row.length) { row.push(field); yield row; }
}

// ─── 清理 ────────────────────────────────────────────────────────────────
/** ECDICT 的 translation 是多行多義，還混了 [网络] 之類的雜訊。 */
function cleanTranslation(raw) {
  const lines = String(raw)
    .split(/\\n|\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // [网络] 是網路釋義，品質參差；[俚] 等標記保留
    .filter((l) => !/^\[网络\]/.test(l))
    // 詞性另外一欄顯示，不必在釋義開頭再重複一次
    .map((l) => l.replace(/^(?:n|v|vt|vi|adj|adv|ad|a|prep|conj|pron|art|num|int|aux)\.\s*/i, ''))
    .map((l) => l.replace(/^(?:n|v|vt|vi|adj|adv|ad|a|prep|conj|pron|art|num|int|aux)\.\s*/i, ''))
    .filter(Boolean);
  if (lines.length === 0) return '';
  return toTraditional(lines.slice(0, 3).join('\n').slice(0, 160));
}

/**
 * ECDICT 的音標混了非 IPA 字元，實際比對後確認的對應：
 *   ә (U+04D9 西里爾字母) → ə      є/ε → ɛ
 *   ^ → ɡ   （exactly=/i^'zæktli/ 就是 /iɡˈzæktli/）
 *   \\ → ɜ  （permanently=/'p\\:mәntli/ 就是 /ˈpɜːməntli/）
 *   ' → ˈ（主重音）  . 與 , → ˌ（次重音）  : → ː（長音）
 * 另外 ; 與「逗號＋空格」用來分隔英美不同讀法，只保留第一種。
 * (ə) (r) 這類括號是「可省略的音」的標準寫法，保留。
 */
const IPA_MAP = {
  'ә': 'ə', 'є': 'ɛ', 'ε': 'ɛ', '^': 'ɡ', '\\': 'ɜ',
  "'": 'ˈ', '.': 'ˌ', ':': 'ː',
};

function cleanPhonetic(raw) {
  let p = String(raw).trim();
  if (!p) return '';

  // 只取第一種讀法
  p = p.split(';')[0];
  p = p.split(/,\s+/)[0];

  p = p.replace(/^\/+|\/+$/g, '').trim();
  p = p.replace(/[@?]/g, '');
  // 原始資料裡的反斜線是連續多個（例如 'p\\\\:mәntli'），
  // 逐字對應會變成 ɜɜɜɜ，所以整串先收斂成一個
  p = p.replace(/\\+/g, 'ɜ');

  let out = '';
  for (const ch of p) {
    if (ch === ',') { out += 'ˌ'; continue; }
    out += IPA_MAP[ch] ?? ch;
  }

  out = out.replace(/\s+/g, ' ').replace(/[-\s]+$/, '').trim();
  return out ? `/${out}/` : '';
}

/** 從 translation 的開頭抓詞性（n. / v. / adj. …） */
function extractPos(translation, posField) {
  const m = String(translation).match(/^\s*((?:n|v|vt|vi|adj|adv|prep|conj|pron|art|num|int|aux)\.)/);
  if (m) return m[1];
  // pos 欄位格式是 "n:70/v:30"
  const p = String(posField).split('/')[0]?.split(':')[0];
  return p ? `${p}.` : '';
}

// 冠詞、代名詞、基本助動詞當單字卡沒有意義 —— 任何程度的人都認得，
// 卻會占掉最前面幾十張卡。介系詞保留，因為那確實是學習難點。
const FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'be', 'am', 'is', 'are', 'was', 'were', 'been', 'being',
  'do', 'does', 'did', 'done', 'have', 'has', 'had', 'having',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours', 'theirs',
  'this', 'that', 'these', 'those', 'who', 'whom', 'whose', 'which', 'what',
  'and', 'or', 'but', 'not', 'no', 'yes', 'so', 'as', 'if', 'than', 'then',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'there', 'here', 'very', 'too', 'also', 'just', 'only', 'more', 'most',
  // 介系詞與質詞：學習難點在搭配用法，不在單字卡。
  // 保留在卡堆最前面只會讓前十張全是「of = 的, 屬於」這種沒用的卡。
  'of', 'in', 'to', 'for', 'with', 'on', 'by', 'at', 'from', 'into',
  'about', 'out', 'up', 'off', 'over', 'down', 'through', 'between',
  'against', 'during', 'without', 'before', 'after', 'under', 'around',
]);

const TAG_LABEL = {
  zk: '國中', gk: '高中', cet4: '四級', cet6: '六級',
  ky: '考研', toefl: 'TOEFL', ielts: 'IELTS', gre: 'GRE',
};

/**
 * 難度以詞頻為主。先前讓考試標籤蓋過詞頻，結果 poster（第 4000 名左右）
 * 因為帶 ky 標籤被標成 hard，明顯不合理 —— 標籤只用來把國高中詞往下調。
 */
function difficultyFor(rank, tags) {
  let level = rank <= 2000 ? 'easy' : rank <= 5000 ? 'medium' : 'hard';
  if ((tags.includes('zk') || tags.includes('gk')) && level === 'hard') level = 'medium';
  return level;
}

// ─── 主流程 ──────────────────────────────────────────────────────────────
async function ensureCsv() {
  if (fs.existsSync(CSV_PATH)) return CSV_PATH;
  console.log(`找不到 ${CSV_PATH}，從 ECDICT 下載（約 63 MB）…`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`下載失敗：HTTP ${res.status}`);
  fs.writeFileSync(CSV_PATH, Buffer.from(await res.arrayBuffer()));
  console.log('下載完成。');
  return CSV_PATH;
}

const csvPath = await ensureCsv();
console.log(`讀取 ${csvPath} …`);
const text = fs.readFileSync(csvPath, 'utf8');

let header = null;
const candidates = [];
let scanned = 0;

for (const row of parseCsv(text)) {
  if (!header) { header = row; continue; }
  scanned++;
  const rec = Object.fromEntries(header.map((k, i) => [k, row[i] ?? '']));

  const word = rec.word?.trim();
  if (!word) continue;

  // 只要一般學習用的詞：小寫開頭、字母為主，允許連字號、撇號與片語空格
  if (!/^[a-z][a-z'\- ]*[a-z]$/.test(word)) continue;
  if (word.length < 2) continue;
  if (FUNCTION_WORDS.has(word)) continue;
  // 縮寫殘片（n't、'll 之類）不是單字
  if (word.includes("'") && word.length <= 4) continue;

  const phonetic = cleanPhonetic(rec.phonetic);
  const translation = cleanTranslation(rec.translation);
  if (!phonetic || !translation) continue;

  // 詞頻：frq 是當代語料庫排名，bnc 是英國國家語料庫排名，越小越常用
  const frq = Number(rec.frq) || 0;
  const bnc = Number(rec.bnc) || 0;
  const rank = frq > 0 && bnc > 0 ? Math.min(frq, bnc) : (frq || bnc);
  if (!rank) continue;

  candidates.push({
    word,
    ipa: phonetic,
    pos: extractPos(rec.translation, rec.pos),
    meaning_zh: translation,
    definition_en: String(rec.definition).split(/\\n|\n/)[0].trim().slice(0, 120),
    tags: String(rec.tag).split(/\s+/).filter(Boolean),
    oxford: rec.oxford === '1',
    collins: Number(rec.collins) || 0,
    rank,
  });
}

console.log(`掃描 ${scanned.toLocaleString()} 筆，符合條件 ${candidates.length.toLocaleString()} 筆。`);

candidates.sort((a, b) => a.rank - b.rank);
const chosen = candidates.slice(0, TOTAL);
console.log(`取詞頻前 ${chosen.length.toLocaleString()} 個。`);

// 只刪自己產生的檔案 —— curated.json 是手寫的，砍掉就回不來了
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const name of fs.readdirSync(OUT_DIR)) {
  if (/^(band-\d{2}|tier-\d+|tier-map|index)\.json$/.test(name)) {
    fs.rmSync(path.join(OUT_DIR, name));
  }
}

/** 一張卡的形狀。band 與 tier 兩種牌組共用，差別只在 `tier` 是誰算的。 */
function cardOf(c, id, bandNo) {
  return {
    id,
    word: c.word,
    ipa: c.ipa,
    pos: c.pos,
    meaning_zh: c.meaning_zh,
    definition_en: c.definition_en || undefined,
    level: bandNo,
    difficulty: difficultyFor(id, c.tags),
    // 難度分級。規則在 vocab-levels.js，band 與 tier 兩邊寫進去的是同一個值
    tier: tierFor(c),
    tags: c.tags.length ? c.tags.map((t) => TAG_LABEL[t] ?? t) : undefined,
    // Collins 星等（0–5，5 最常用）與 Oxford 3000 標記。
    // 腳本本來就讀進來了，只是以前沒寫出去 —— 沒有標籤的字要靠它們補位分級，
    // 前端也拿它顯示「這個字有多常用」。
    collins: c.collins || undefined,
    oxford: c.oxford || undefined,
  };
}

// id 就是全域詞頻排名（band-03 的 id 是 2001…3000），所以跨牌組不會重複 ——
// tier 牌組直接沿用同一個 id，同一個字在兩種切法裡是同一張卡。
const cards = chosen.map((c, i) => cardOf(c, i + 1, Math.floor(i / BAND_SIZE) + 1));

// ─── 依詞頻切：band ───────────────────────────────────────────────────────
const bands = [];
for (let start = 0; start < cards.length; start += BAND_SIZE) {
  const bandNo = bands.length + 1;
  const slice = cards.slice(start, start + BAND_SIZE);
  const file = `band-${String(bandNo).padStart(2, '0')}.json`;
  fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(slice, null, 1));
  bands.push({
    id: `band-${bandNo}`,
    file,
    count: slice.length,
    from: start + 1,
    to: start + slice.length,
    label: `第 ${(start + 1).toLocaleString()}–${(start + slice.length).toLocaleString()} 常用`,
    note: '依語料庫詞頻排序，取自 ECDICT。',
  });
}

// ─── 依難度切：tier ───────────────────────────────────────────────────────
// 考試標籤跨所有 band（國中的字散在第 1 到第 10 個級距裡），所以這裡必須
// **在建置期重新切檔**：前端一個牌組只載一個檔案，組不出跨檔的分級。
const tiers = [];
for (const [i, tier] of TIERS.entries()) {
  const slice = cards.filter((c) => c.tier === tier.id);
  const file = `${tier.id}.json`;
  fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(slice, null, 1));
  tiers.push({
    id: tier.id,
    file,
    count: slice.length,
    order: i + 1,
    label: tier.label,
    note: tier.note,
  });
}

// id → 第幾級的對照表。索引 0 是 id 1，值是 tier 的順序（1 起算）。
// 有了它，「各級進度」只要這一個小檔案加 localStorage 就算得出來，
// 不必把 3 MB 的字庫全部載進來。
const tierOrder = new Map(tiers.map((t) => [t.id, t.order]));
fs.writeFileSync(path.join(OUT_DIR, 'tier-map.json'), JSON.stringify({
  note: '索引 0 對應 id 1。值是 index.json 裡 tier 的 order。',
  tiers: tiers.map(({ id, order, label, count }) => ({ id, order, label, count })),
  byId: cards.map((c) => tierOrder.get(c.tier)),
}));

// ─── 牌組目錄 ────────────────────────────────────────────────────────────
// App 的切換畫面讀的是 `decks`。curated 不由這支腳本產生，但它是預設牌組，
// 所以這裡要把它列進去（檔案還在的話才列，字數直接數檔案裡的）。
const decks = [];
const curatedPath = path.join(OUT_DIR, 'curated.json');
if (fs.existsSync(curatedPath)) {
  decks.push({
    id: 'curated',
    kind: 'curated',
    file: 'curated.json',
    count: JSON.parse(fs.readFileSync(curatedPath, 'utf8')).length,
    label: '精選（含例句與發音提示）',
    note: '手寫的主題單字，每張都有例句、中譯與發音提示。',
    // 複習進度的命名空間。curated 的 id 從 1 起算、跟 ECDICT 的字會撞，
    // 所以分開；band 與 tier 是同一批字的兩種切法，共用 `ecdict`，
    // 這樣在 band-1 記熟的字換去 tier-1 練不會變回「沒學過」。
    keyspace: 'curated',
  });
} else {
  console.warn('⚠️  找不到 curated.json，index.json 不會列出精選牌組。');
}
for (const t of tiers) decks.push({ ...t, kind: 'tier', keyspace: 'ecdict' });
for (const b of bands) decks.push({ ...b, kind: 'band', keyspace: 'ecdict' });

fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({
  source: 'ECDICT (https://github.com/skywind3000/ECDICT, MIT)',
  total: cards.length,
  bandSize: BAND_SIZE,
  tierMapFile: 'tier-map.json',
  decks,
}, null, 1));

console.log(`\n輸出到 ${OUT_DIR}`);
console.log(`\n依難度分級（拿來選「我要練哪一級」的）：`);
for (const t of tiers) console.log(`  ${t.file.padEnd(12)} ${t.label.padEnd(22)} ${String(t.count).padStart(5)} 字`);
console.log(`\n依詞頻級距（既有牌組，進度都在這裡）：`);
for (const b of bands) console.log(`  ${b.file}  ${b.label}  ${b.count} 字`);
