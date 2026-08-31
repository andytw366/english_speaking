// 重算 phonetics.js 裡的 BASELINE（各個音在語料庫裡的平均密度）。
//
//   npm run corpus:baseline
//
// 換語料庫、或改了 issueScores() 的算法之後要重跑，把印出來的表貼回 phonetics.js。
// 不自動寫檔是刻意的：這張表會直接影響每一句的 focus，值得有人看過再決定要不要換。

import pairs from 'tatoeba-sentence-pairs-in-mandarin-chinese-english';
import { issueScores } from './phonetics.js';

const MIN_WORDS = 5;
const MAX_WORDS = 13;

const sums = new Map();
let counted = 0;

for (const [, , , english] of pairs) {
  const length = english.split(/\s+/).filter(Boolean).length;
  if (length < MIN_WORDS || length > MAX_WORDS) continue;

  const scores = issueScores(english);
  if (!scores) continue;

  counted += 1;
  for (const [issue, value] of scores) sums.set(issue, (sums.get(issue) ?? 0) + value);
}

console.log(`取樣 ${counted.toLocaleString()} 句（${MIN_WORDS}～${MAX_WORDS} 字）\n`);
console.log('export const BASELINE = new Map([');
for (const [issue, total] of [...sums].sort((a, b) => b[1] - a[1])) {
  console.log(`  ['${issue}', ${(total / counted).toFixed(4)}],`);
}
console.log(']);');
