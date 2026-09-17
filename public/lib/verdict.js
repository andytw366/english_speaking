// 對完答案之後那張卡**最上面那一句話**：這一題到底算好還是不好。
//
// ─── 為什麼要有這個檔案 ──────────────────────────────────────────────────
//
// 以前這句話一律由 `lib/grade.js` 決定 —— 拿題目附的那句答案當標準比對關鍵字。
// 它免費、離線、瞬間，但**它看不懂你寫了什麼**：關鍵字都有而文法壞掉會判
// 「意思對了」，寫得比題目那句更自然反而可能判「再想想」。
//
// AI 修正接上去之後，同一張卡上就有了兩個判定，而它們會互相打臉：
//
//     ❌ 再想想                  ← 本地比對：少了題目那句裡的某個字
//     🤖 AI：這樣說可以           ← 模型：這句話本身沒問題
//
// 使用者只能相信其中一個，而畫面沒有告訴他要相信哪一個 —— 那比只有一個
// （哪怕是比較笨的那一個）更糟。
//
// 所以判定只留一個：**模型看過就以模型的為準**，題目附的那句話降級成一個例句
// （「可以這樣說」的一種寫法，不是標準答案）。模型沒看的時候才退回關鍵字比對
// —— 那時候畫面上確實只有例句可以比，說它是在跟例句對照也是誠實的。
//
// 中翻英與情境對話共用這一份（兩個模式的結果卡本來就長一樣），
// 而且是純函式 —— 五種狀態每一種都測得到（`test/verdict.test.js`）。

import { RESULT_HEAD } from './grade.js';

/**
 * 模型三級判定的中文與顏色。伺服器只回 `ok` / `minor` / `major`（見
 * `server/coach.js` 的 `VERDICTS`），中文寫在前端。
 *
 * **標題裡要寫「AI」**：這句話是模型說的，而模型每次的意見可能不同、也可能
 * 出錯。不寫的話，使用者會以為那是這題的標準判定，然後在它跟例句不一致的時候
 * 以為程式壞了。
 */
export const AI_HEAD = {
  ok: ['✅ AI：這樣說可以', 'ok'],
  minor: ['🟡 AI：小地方可以更自然', 'close'],
  major: ['❌ AI：這句要改', 'bad'],
};

/**
 * 還在等模型的時候那一句。
 *
 * **不先秀本地判定**：本地那一級兩秒後就會被模型的判定換掉，而「❌ 再想想」
 * 閃一下再變成「✅ 這樣說可以」比從頭到尾沒有結論更難受 —— 使用者會記得
 * 第一個看到的那個字。中性的一句話講的是實話：結論還沒到。
 *
 * 卡片本身照樣立刻畫出來（例句、逐字比對、按鈕都在），等的只有這一行。
 */
export const WAITING_HEAD = ['🤖 AI 正在看你這一句…', 'wait'];

/**
 * 這一題最後要顯示哪一個判定。
 *
 * @param {{phase?: string, verdict?: string|null}|null} ai
 *   `lib/ai-review.js` 的 reviewer 狀態（`phase` + `verdict`）
 * @param {{level?: string}|null} local `lib/grade.js` 的 `grade()` 結果
 * @returns {{title: string, tone: string, source: 'ai'|'local'|'waiting'}}
 *   source 是**畫面要用的**：`local` 以外的時候，那些「拿例句當標準」的東西
 *   （少了哪些關鍵用字）就不該再出現，不然又變成兩個判定
 */
export function pickVerdict(ai, local) {
  const level = local?.level;

  // 空白作答排在最前面：那時候沒有句子可以評，AI 修正也不會去要
  // （見 `ai-review.js` 的 `begin()`），拿模型上一題的判定來用會是錯的
  if (level === 'empty' || !level) return head(RESULT_HEAD.empty, 'local');

  if (ai?.phase === 'loading') return head(WAITING_HEAD, 'waiting');

  // 模型看過了就以它為準。`verdict` 是空的代表這次整理不出判定 ——
  // 那跟沒問過一樣，退回本地
  if (ai?.phase === 'done' && AI_HEAD[ai.verdict]) return head(AI_HEAD[ai.verdict], 'ai');

  // 剩下的都是「模型沒看」：關掉、手動還沒按、這次沒回來、沒設定金鑰、額度用完
  return head(RESULT_HEAD[level] ?? RESULT_HEAD.empty, 'local');
}

function head([title, tone], source) {
  return { title, tone, source };
}

/**
 * 這一句算不算「表達到位」。情境對話的總結（「7 句裡有 5 句表達到位」）與
 * 對話記錄要不要附例句都看它。
 *
 * **模型的判定優先**，理由跟 `pickVerdict()` 一樣：同一句話在卡片上說「可以」、
 * 在總結裡算成沒過關的話，那個總結就沒有意義了。
 *
 * 到位的門檻是 `ok` 與 `minor`：`minor` 是「意思到了、但有小地方可以更自然」，
 * 對應本地的「意思對了」—— 這個模式練的是把話講出去，不是把話講完美。
 *
 * @param {{level?: string, aiVerdict?: string|null}} said 一句台詞的結果
 */
export function isPass(said) {
  if (said?.aiVerdict) return said.aiVerdict === 'ok' || said.aiVerdict === 'minor';
  return said?.level === 'exact' || said?.level === 'close';
}
