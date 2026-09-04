/**
 * 單字的難度分級（tier）。
 *
 * **為什麼不用現成的 `difficulty` 欄位**：那一欄是從詞頻機械換算的
 * （前 2,000 = easy、2,001–5,000 = medium、其餘 hard），所以它跟「第幾個 1,000 常用」
 * 是同一件事的兩種說法 —— 拿它當難度選單等於還是在選 band。
 *
 * **為什麼用考試標籤當主訊號**：ECDICT 的 tag 欄位（zk 國中、gk 高中、cet4 四級、
 * cet6 六級、ky 考研、toefl、ielts、gre）是**人訂的範圍**，而且對台灣的使用者
 * 是最好懂的難度刻度 —— 「國中」「高中」比「第 3,000–4,000 常用」直覺得多。
 * 取「最簡單的那一個標籤」：一個字同時掛 zk 與 gre 的時候，它是國中就學過的字，
 * 不是 GRE 單字。
 *
 * **沒有標籤的字怎麼辦**（10,000 個裡有 2,272 個）：這些多半是沒進任何考試範圍的
 * 中低頻字。用詞頻與 Collins 星等補位 —— Collins 是柯林斯詞典的常用度星等
 * （5 星最常用、0 表示沒收），比純詞頻穩，因為詞頻排名在後段會被專有名詞與
 * 領域詞干擾。
 *
 * 這個模組是純函式，沒有 fs 也沒有網路 —— `build-vocabulary.mjs` 與
 * `test/vocabulary.test.js` 共用同一份規則，不能各寫一份。
 */

/** 由簡到難。`tags` 是 ECDICT 的原始標籤代碼。 */
export const TIERS = [
  {
    id: 'tier-1',
    label: '入門｜國中',
    tags: ['zk'],
    note: '國中課綱範圍。看不懂的字最多的話從這裡開始。',
  },
  {
    id: 'tier-2',
    label: '基礎｜高中',
    tags: ['gk'],
    note: '高中課綱範圍，也收沒有考試標籤但很常用的字。',
  },
  {
    id: 'tier-3',
    label: '進階｜四級',
    tags: ['cet4'],
    note: '大學四級範圍。日常閱讀與一般工作場合的主力字彙。',
  },
  {
    id: 'tier-4',
    label: '高階｜六級',
    tags: ['cet6'],
    note: '大學六級範圍。開始出現書面語與抽象詞。',
  },
  {
    id: 'tier-5',
    label: '檢定｜TOEFL / IELTS',
    tags: ['toefl', 'ielts'],
    note: '留學檢定範圍。學術與新聞用字。',
  },
  {
    id: 'tier-6',
    label: '艱深｜GRE 與冷門字',
    tags: ['gre', 'ky'],
    note: 'GRE、考研，以及沒進任何考試範圍的低頻字。',
  },
];

export const TIER_IDS = TIERS.map((t) => t.id);

/** ECDICT 標籤 → tier id。由簡到難，第一個命中的就是答案。 */
const TAG_TO_TIER = TIERS.flatMap((t) => t.tags.map((tag) => [tag, t.id]));

/**
 * 一個字屬於哪一級。
 *
 * @param {{ tags?: string[], rank?: number, collins?: number }} word
 *   tags   ECDICT 的原始標籤代碼（`zk` / `gk` / `cet4`…），不是中文標籤
 *   rank   詞頻排名（越小越常用），沒有標籤時用來補位
 *   collins 柯林斯星等 0–5（5 最常用），沒有標籤時用來補位
 * @returns {string} TIER_IDS 裡的一個
 */
export function tierFor({ tags = [], rank = 0, collins = 0 } = {}) {
  const set = new Set(tags);
  for (const [tag, id] of TAG_TO_TIER) {
    if (set.has(tag)) return id;
  }

  // 沒有考試標籤：常用的往前放，其餘歸到最後一級。
  // 門檻用 2,000 / 5,000 是為了跟既有的 easy / medium / hard 對得起來
  // （見 build-vocabulary.mjs 的 difficultyFor），不是另外發明一套。
  if (collins >= 4 || (rank > 0 && rank <= 2000)) return 'tier-2';
  if (collins >= 3 || (rank > 0 && rank <= 5000)) return 'tier-3';
  return 'tier-6';
}
