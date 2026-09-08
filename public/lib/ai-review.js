// AI 修正的前端這一半：問伺服器「這個功能現在能不能用」、送一句話去要修正、
// 以及那一段畫面長什麼樣。
//
// **情境對話與中翻英共用這一份**（`server/coach.js` 是它在後端的另一半）。
// 為什麼共用：兩個模式問的是同一個問題（「我這樣寫，母語人士會怎麼說」），
// 而狀態機的每一種狀態都有一個「說錯話就讓人以為壞了」的陷阱：
//
//   1. **請求飛在半路時使用者已經換題了**。沒有處理的話，上一題的修正會蓋在
//      下一題的畫面上，而那個 bug 只有手速快的時候才出現（`token` 那一段）
//   2. **同一句話問第二次要花第二次錢**。「再試一次」按下去、答案一個字都沒改
//      是很常見的動作（`cachedFor()` 那一段）
//   3. 四種狀態（還沒要／正在要／要到了／要不到）**各自要說不同的話**，
//      分不清楚的代價都是「以為壞了」
//
// 各寫一份的話，這三件事會有一邊寫錯，而且不會有人回報 —— 只會覺得不太可靠。
//
// 金鑰一律不進瀏覽器 —— 這裡只送文字，模型是伺服器呼叫的（見 server/settings.js）。

import { h, append } from './dom.js';
import { speak, isSupported as ttsSupported } from './tts.js';
import { getReviews, saveReview } from './storage.js';
import { normalize } from './grade.js';

/**
 * 「這台伺服器現在有沒有一條可以呼叫的模型」。
 *
 * 整個 App 共用一個 promise：同一次載入裡問幾次都只有一趟網路。
 * 換了金鑰之後要重新問的那一趟由設定頁負責 —— 它存完會呼叫
 * `forgetAiReviewAvailability()`，不然「剛剛才設好金鑰」的那次要重新整理才會通。
 */
let capsPromise = null;

export function aiReviewAvailability() {
  if (!capsPromise) {
    capsPromise = fetch('/api/capabilities')
      .then((res) => (res.ok ? res.json() : null))
      .then((caps) => caps?.aiReview ?? null)
      // 讀不到不等於不能用 —— 回 null（「不知道」），畫面上不要說死。
      // 說死的代價是使用者以為功能壞了，而其實只是這一趟請求掉了
      .catch(() => null);
  }
  return capsPromise;
}

/** 金鑰改過之後把快取丟掉，下一次會重新問。設定頁存完金鑰時呼叫。 */
export function forgetAiReviewAvailability() {
  capsPromise = null;
}

/**
 * 送一句話去要一次 AI 修正。**不丟例外** —— 一律回一個可以直接顯示的結果。
 *
 * 為什麼連網路錯誤都不丟：呼叫端是「對答案」之後的一段附加資訊，
 * 本地批改與參考答案已經在畫面上了。丟例外的話那邊就要再寫一層 try，
 * 而漏掉的症狀是整個模式當掉 —— 代價完全不對等。
 *
 * @param {object} task 見 server/coach.js 的 `parseReviewRequest()`：
 *   `mode`（dialogue / translation）、`input`（必要）與各自的上下文欄位
 * @returns {Promise<{ok: true, review: object, label?: string, ms?: number, quota?: object}
 *   | {ok: false, reason: 'no_key'|'quota'|'failed'|'no_input', message: string}>}
 */
export async function requestReview(task) {
  try {
    const res = await fetch('/api/answer-review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(task),
    });
    const body = await res.json().catch(() => null);

    if (!res.ok) {
      return {
        ok: false,
        reason: body?.error === 'no_input' ? 'no_input' : 'failed',
        message: body?.message ?? `AI 修正失敗（HTTP ${res.status}）。`,
      };
    }
    if (!body?.ok) {
      return {
        ok: false,
        // quota 是「今天的次數用完了」—— 跟 failed 分開，因為再按一次也沒有用
        reason: ['no_key', 'quota'].includes(body?.reason) ? body.reason : 'failed',
        message: body?.message ?? 'AI 修正這次沒有回來。',
        quota: body?.quota ?? null,
      };
    }
    return body;
  } catch (err) {
    console.error('[ai-review]', err);
    return {
      ok: false,
      reason: 'failed',
      message: '連不到伺服器，AI 修正這次沒有回來（本地批改與參考答案不受影響）。',
    };
  }
}

// ─── 中文講評的「手動」那條路 ────────────────────────────────────────────
//
// 為什麼跟 AI 修正放同一個檔案：它們是同一件事的三個分身 ——
// 同一組設定（自動／手動／關）、同一個每日額度、同一種「這次沒回來」的說法。
// 分開放的話，「今天還剩幾次」與各種失敗訊息會有兩份，而它們一定會慢慢分岔。

/**
 * 手動要一次中文講評。送的是**已經算好的評估結果**，不是錄音 ——
 * 再送一次錄音等於再花一次 Azure 的錢，而講評要的只是那幾個數字。
 *
 * 跟 `requestReview()` 一樣：**不丟例外**，一律回一個可以直接顯示的結果。
 */
export async function requestNarration(assessment, { model } = {}) {
  try {
    const res = await fetch('/api/narration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ assessment, model }),
    });
    const body = await res.json().catch(() => null);

    if (!res.ok) {
      return { ok: false, reason: 'failed', message: body?.message ?? `講評失敗（HTTP ${res.status}）。` };
    }
    if (!body?.ok) {
      return {
        ok: false,
        reason: ['no_key', 'quota'].includes(body?.reason) ? body.reason : 'failed',
        message: body?.message ?? '這次的講評沒有回來。',
        quota: body?.quota ?? null,
      };
    }
    return body;
  } catch (err) {
    console.error('[ai-narration]', err);
    return { ok: false, reason: 'failed', message: '連不到伺服器，這次的講評沒有回來（分數不受影響）。' };
  }
}

/** 一題在快取裡的鍵。模式當前綴 —— 兩個模式的題號會撞（都是從 1 開始的數字）。 */
export function reviewKey(mode, ...parts) {
  return [mode, ...parts].join(':');
}

/**
 * 這一題以前要過修正嗎（同一題、**而且寫的是同一句話**）。
 *
 * 第二個條件是重點：句子改過之後，舊的那份講的是另一句話，
 * 拿出來會變成「AI 說的跟我寫的對不上」——比沒有修正更糟。
 */
export function storedReview(key, input) {
  const stored = getReviews()[key];
  if (!stored || !input) return null;
  return normalize(stored.input ?? '') === normalize(input) ? stored : null;
}

/**
 * 判定的三級要怎麼顯示。伺服器只回 `ok` / `minor` / `major` 三個字 ——
 * 中文與顏色是畫面的事，寫在前端。
 */
export const VERDICT_HEAD = {
  ok: ['🤖 AI：這樣說可以', 'ok'],
  minor: ['🤖 AI：可以更自然', 'close'],
  major: ['🤖 AI：這句要改', 'bad'],
};

/**
 * 「今天還剩幾次」那一行。剩很多的時候不寫 —— 每一句都提醒剩幾次，
 * 會把一個安全網變成一個計時器。
 *
 * @param {{remaining: number|null}|null|undefined} quota 伺服器回來的額度資訊
 */
export function quotaNote(quota) {
  const left = quota?.remaining;
  if (typeof left !== 'number') return '';   // 沒有設上限
  if (left > 20) return '';
  return left > 0
    ? `今天還可以呼叫 ${left} 次（所有模式一起算）。`
    : '今天的呼叫次數已經用完了。';
}

/**
 * 一個模式用的 AI 修正「小引擎」：狀態、快取、與那一段畫面。
 *
 * 用法（兩個模式都一樣）：
 * ```js
 * const reviewer = createReviewer({ onChange: render });
 * // 對答案時：
 * reviewer.begin({ key, input, task, mode: aiMode('dialogue') });
 * // 畫面上：
 * append(card, reviewer.view());
 * // 換題／再試一次：
 * reviewer.reset();
 * ```
 *
 * @param {{onChange: () => void}} options onChange 就是模式的 render()
 */
export function createReviewer({ onChange }) {
  let state = null;      // null（還沒要）| { phase: 'loading'|'done'|'error', … }
  let request = null;    // 最近一次的 { key, input, task } —— 「再要一次」要用
  // 每要一次就 +1。回應回來時對不上就丟掉（陷阱 1）
  let token = 0;
  // 伺服器有沒有一條可以呼叫的模型。null = 還不知道（那一趟請求還沒回來或掉了），
  // **不知道時當作可以試** —— 說死「不能用」的代價是使用者以為功能壞了
  let ready = null;
  aiReviewAvailability().then((info) => { ready = info; });

  /** 真的去要一次。空白的答案不送 —— 沒有東西可以改，而那仍然是一次呼叫。 */
  function ask() {
    if (!request?.input) return;
    const mine = ++token;
    state = { phase: 'loading' };
    onChange();

    requestReview({ ...request.task, input: request.input }).then((out) => {
      // 對不上 token 就是「這已經不是剛才那一題了」—— 直接丟掉
      if (mine !== token) return;
      state = out.ok
        ? { phase: 'done', data: out.review, label: out.label, ms: out.ms, quota: out.quota }
        : { phase: 'error', reason: out.reason, message: out.message, quota: out.quota };

      // 存起來：重新整理不會消失，而且同一句話不會再付第二次錢（陷阱 2）。
      // 存的是**當時寫的句子**加上修正 —— 比對句子是快取能不能用的唯一依據
      if (out.ok) {
        saveReview(request.key, {
          input: request.input,
          corrected: out.review.corrected ?? null,
          verdict: out.review.verdict,
          notes: out.review.notes ?? [],
          label: out.label ?? '',
        });
      }
      onChange();
    });
  }

  return {
    /**
     * 對答案時呼叫。先看快取，沒有才（自動模式）去要一次。
     *
     * **存下來的修正三種模式都會顯示**，關掉也一樣 —— 那一份已經付過錢了，
     * 藏起來不會省到任何東西，只會讓人以為資料不見了。
     *
     * @param {{key: string, input: string, task: object,
     *   mode?: 'auto'|'manual'|'off'}} options 見 `lib/settings.js` 的 `aiMode()`
     */
    begin({ key, input, task, mode = 'auto' }) {
      token++;                 // 還在飛的那一個作廢
      const clean = (input ?? '').trim();
      request = { key, input: clean, task, mode };

      const cached = storedReview(key, clean);
      if (cached) {
        state = { phase: 'done', data: cached, label: cached.label, cached: true };
        onChange();
        return;
      }
      state = null;
      if (mode === 'auto' && clean) ask();
      else onChange();
    },

    /** 手動要一次（畫面上的按鈕）。 */
    ask,

    /** 換題、或使用者按「再試一次」要重寫答案時。 */
    reset() {
      state = null;
      request = null;
      token++;
    },

    /** 現在的狀態（給模式判斷要不要畫別的東西用）。 */
    get phase() {
      return state?.phase ?? 'idle';
    },

    /**
     * 那一段畫面。**永遠不會取代參考答案** —— 它接在那些東西後面。
     *
     * 四種狀態各自要說不同的話，而分不清楚的代價都是「以為壞了」：
     *   還沒要（自動修正關掉時）→ 一個按鈕，按了才花錢
     *   要不到（伺服器沒設定模型）→ 講清楚要去哪裡設定，不要給一個按了也沒用的按鈕
     *   正在要 → 明講在等什麼，不然那幾秒看起來像卡住
     *   要到了 / 這次沒回來 → 前者顯示修正，後者給一個「再要一次」
     */
    view() {
      const box = h('div', { class: 'airev' });

      // 空白作答不給按鈕：沒有東西可以改，而那仍然是一次要花錢的呼叫
      if (!request?.input) return box;

      if (state?.phase === 'loading') {
        append(box, h('p', { class: 'status status--busy' }, '🤖 AI 正在看你寫的這一句…'));
        return box;
      }

      if (state?.phase === 'error') {
        append(box,
          // 前面加上機器人：這一行講的是 AI 修正的事，而它前面就是教材的參考答案 ——
          // 沒有記號的話看起來像在說剛才那次作答出了什麼問題
          h('p', { class: 'hint hint--warn' }, `🤖 ${state.message}`),
          // 沒設定模型、或今天的次數用完了都不給「再要一次」——
          // 按幾次都會是同一個結果，而其中一種還會讓人以為是自己按得不夠多
          !['no_key', 'quota'].includes(state.reason)
            && h('button', { class: 'btn btn--ghost', onclick: ask }, '🤖 再要一次'),
        );
        return box;
      }

      if (state?.phase === 'done') {
        append(box, resultBox(state, request.input));
        return box;
      }

      // 關掉的話連按鈕都不畫 —— 那正是「關」跟「手動」的差別
      if (request.mode === 'off') return box;

      // 還沒要。伺服器那邊根本沒有模型可用的話，給的是說明而不是按鈕
      if (ready && ready.ready === false) {
        append(box, h('p', { class: 'hint' },
          `🤖 AI 修正目前不能用（${ready.problem}）。` +
          '設定好之後，這裡會多一段「你這句話本身怎麼樣」的建議。'));
        return box;
      }

      append(box,
        h('button', { class: 'btn btn--ghost', onclick: ask }, '🤖 讓 AI 看我這一句'),
        h('p', { class: 'hint' }, '按 A 也可以。會把你的句子連同題目送給伺服器設定的模型，換一句更自然的說法。'),
      );
      return box;
    },
  };
}

/** 修正回來之後長什麼樣。 */
function resultBox({ data, label, ms, quota, cached }, input) {
  const [title, tone] = VERDICT_HEAD[data.verdict] ?? VERDICT_HEAD.minor;
  const box = h('div', { class: `airev__box airev__box--${tone}` },
    h('p', { class: 'airev__title' }, title),
  );

  // 模型把原句照抄回來時不要再秀一次一模一樣的句子 —— 那只會讓人以為它沒看懂
  const unchanged = data.corrected && normalize(data.corrected) === normalize(input);

  if (data.corrected && !unchanged) {
    append(box,
      h('p', { class: 'airev__line' },
        data.corrected,
        ttsSupported() && h('button', {
          class: 'bubble__play',
          title: '唸這一句',
          onclick: (e) => replay(data.corrected, e.currentTarget),
        }, '🔊'),
      ),
    );
  } else if (unchanged) {
    append(box, h('p', { class: 'hint' }, '你原本那句就可以直接用，不用改。'));
  }

  for (const note of data.notes ?? []) {
    append(box, h('p', { class: 'airev__note' }, `• ${note}`));
  }

  append(box, h('p', { class: 'airev__by' },
    `由 ${label || '伺服器設定的模型'} 產生` +
    (typeof ms === 'number' ? `，等了 ${(ms / 1000).toFixed(1)} 秒` : '') +
    // 從快取拿的要講出來：不然「這次怎麼是瞬間出現」看起來像沒有真的問過
    (cached ? '（這一題你之前已經問過了，直接拿存下來的，沒有再呼叫一次）' : '') +
    '。這是模型的意見，跟上面教材的參考答案不一樣是正常的。'));

  const note = quotaNote(quota);
  if (note) append(box, h('p', { class: 'airev__by' }, note));

  return box;
}

async function replay(text, button) {
  button.disabled = true;
  try {
    await speak(text);
  } catch (err) {
    console.error('[tts]', err);
  } finally {
    button.disabled = false;
  }
}
