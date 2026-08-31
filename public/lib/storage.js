// localStorage 包一層：私密瀏覽或停用儲存時不會炸掉，只是不記錄。

const PREFIX = 'speaking-coach:';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    // 私密瀏覽、配額用盡都會走到這裡。功能照常，只是不記錄。
    return false;
  }
}

// ─── 單字卡的間隔重複（Leitner 盒子制）─────────────────────────────────
// 盒子 1～5，答對就往上一盒、間隔拉長；答錯直接回第 1 盒。
// 用盒子制而不是 SM-2，是因為行為好預測、出問題也容易看懂。
const BOX_INTERVAL_DAYS = [0, 1, 3, 7, 21];
const DAY_MS = 24 * 60 * 60 * 1000;

export function getSrsState() {
  return read('srs', {});
}

/**
 * 每張卡的 SRS 鍵。不同牌組的 id 會重複（精選第 1 張與第一級距第 1 張都是 id 1），
 * 所以要用牌組名稱做前綴，否則兩張不同的卡會共用同一份複習進度。
 */
export function srsKeyOf(card) {
  return card.srsKey ?? String(card.id);
}

export function getCardState(card) {
  const key = typeof card === 'object' ? srsKeyOf(card) : String(card);
  return getSrsState()[key] ?? { box: 1, due: 0, seen: 0, correct: 0 };
}

export function recordAnswer(card, wasCorrect) {
  const key = typeof card === 'object' ? srsKeyOf(card) : String(card);
  const all = getSrsState();
  const prev = all[key] ?? { box: 1, due: 0, seen: 0, correct: 0 };
  const box = wasCorrect ? Math.min(prev.box + 1, BOX_INTERVAL_DAYS.length) : 1;
  all[key] = {
    box,
    due: Date.now() + BOX_INTERVAL_DAYS[box - 1] * DAY_MS,
    seen: prev.seen + 1,
    correct: prev.correct + (wasCorrect ? 1 : 0),
  };
  write('srs', all);
  return all[key];
}

/**
 * 排出這次要複習的順序：到期的先（越早到期越前面），再來是沒看過的新卡。
 */
export function buildQueue(cards) {
  const state = getSrsState();
  const now = Date.now();
  const due = [];
  const fresh = [];

  for (const card of cards) {
    const s = state[srsKeyOf(card)];
    if (!s) fresh.push(card);
    else if (s.due <= now) due.push({ card, due: s.due });
  }
  due.sort((a, b) => a.due - b.due);
  return [...due.map((d) => d.card), ...fresh];
}

export function srsSummary(cards) {
  const state = getSrsState();
  const now = Date.now();
  let due = 0;
  let fresh = 0;
  let learning = 0;
  let mastered = 0;

  for (const card of cards) {
    const s = state[srsKeyOf(card)];
    if (!s) { fresh++; continue; }
    if (s.due <= now) due++;
    if (s.box >= BOX_INTERVAL_DAYS.length) mastered++;
    else learning++;
  }
  return { due, fresh, learning, mastered, total: cards.length };
}

export function resetSrs() {
  write('srs', {});
}

// ─── 跟讀練習紀錄 ────────────────────────────────────────────────────────
//
// 這份紀錄不只是「看過的清單」—— 它會回頭決定下一句抽什麼（見 lib/practice.js）：
// 分數低的、久沒練的、以及練得到你常錯的音的句子會比較常出現。
// 所以欄位不能只留分數，`problemWords` 的 issue 分類是弱點加權的唯一來源。

/** 保留的筆數上限。200 筆大約是兩三個月的練習量，趨勢圖也只看最近 20 筆。 */
const HISTORY_LIMIT = 200;

/**
 * 記一次練習。
 *
 * `at` 用 ISO 字串而不是毫秒數：間隔重複要算「上次練是多久以前」，
 * 而 `Date.parse(1234567)` 會回 NaN —— 存數字的話那一句會被當成「時間壞掉」。
 * （舊版存的是數字，`practice.js` 兩種都讀得懂，不用洗資料。）
 *
 * @param {object} entry
 * @param {*} entry.sentenceId 例句 id，「重練這句」與依句子彙整成績都靠它
 * @param {string} entry.sentenceText 當時的句子（例句改過之後紀錄仍然看得懂）
 * @param {number|null} entry.score 0～100
 * @param {Array<{word:string, issue:string}>} [entry.problemWords] 弱點加權的來源
 */
export function addAttempt(entry) {
  const list = read('history', []);
  list.unshift({ ...entry, at: new Date().toISOString() });
  const trimmed = list.slice(0, HISTORY_LIMIT);

  if (!write('history', trimmed)) {
    // 配額滿了：砍掉一半再試一次，總比整份紀錄寫不進去好
    const half = trimmed.slice(0, Math.floor(trimmed.length / 2));
    if (write('history', half)) {
      console.warn('[storage] 空間不足，已丟棄較舊的一半練習紀錄');
      return half;
    }
    return trimmed; // 還是寫不進去：回傳記憶體中的清單，至少這次的畫面是對的
  }
  return trimmed;
}

export function getHistory() {
  const list = read('history', []);
  return Array.isArray(list) ? list.filter((r) => r && typeof r === 'object') : [];
}

export function clearHistory() {
  write('history', []);
}

/** 練習次數與平均分。只計入有分數的紀錄。 */
export function summarise(history) {
  const scored = history.filter((r) => typeof r.score === 'number');
  const total = scored.reduce((sum, r) => sum + r.score, 0);
  return {
    count: history.length,
    scoredCount: scored.length,
    average: scored.length ? Math.round(total / scored.length) : null,
    best: scored.length ? Math.max(...scored.map((r) => r.score)) : null,
  };
}
