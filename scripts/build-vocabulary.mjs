#!/usr/bin/env node
/**
 * 從 ECDICT 產生分級單字庫。
 *
 * ECDICT（https://github.com/skywind3000/ECDICT，MIT 授權）收錄約 77 萬筆
 * 英漢詞條，含 IPA 音標、中文釋義、詞性、考試標籤與語料庫詞頻。
 * 這個腳本把它篩選成依詞頻分級的學習用卡片。
 *
 * 用法：
 *   node scripts/build-vocabulary.mjs [--csv <路徑>] [--total 10000] [--band 1000]
 *
 * 沒給 --csv 就會自動下載（約 63 MB）。
 * 產出 content/vocabulary/band-01.json … band-NN.json 與 index.json。
 *
 * 這是「建置期」腳本，不是執行期 —— App 跑起來只讀產出的 JSON。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as OpenCC from 'opencc-js';

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
const OUT_DIR = path.join(ROOT, 'content', 'vocabulary');

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

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const bands = [];
for (let start = 0; start < chosen.length; start += BAND_SIZE) {
  const bandNo = bands.length + 1;
  const slice = chosen.slice(start, start + BAND_SIZE);
  const cards = slice.map((c, i) => ({
    id: start + i + 1,
    word: c.word,
    ipa: c.ipa,
    pos: c.pos,
    meaning_zh: c.meaning_zh,
    definition_en: c.definition_en || undefined,
    level: bandNo,
    difficulty: difficultyFor(start + i + 1, c.tags),
    tags: c.tags.length ? c.tags.map((t) => TAG_LABEL[t] ?? t) : undefined,
  }));

  const file = `band-${String(bandNo).padStart(2, '0')}.json`;
  fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(cards, null, 1));
  bands.push({
    level: bandNo,
    file,
    count: cards.length,
    from: start + 1,
    to: start + cards.length,
    label: `第 ${(start + 1).toLocaleString()}–${(start + cards.length).toLocaleString()} 常用`,
  });
}

fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({
  source: 'ECDICT (https://github.com/skywind3000/ECDICT, MIT)',
  total: chosen.length,
  bandSize: BAND_SIZE,
  bands,
}, null, 1));

console.log(`\n輸出 ${bands.length} 個級距到 content/vocabulary/`);
for (const b of bands) console.log(`  ${b.file}  ${b.label}  ${b.count} 字`);
