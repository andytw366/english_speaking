import { h, append } from '../lib/dom.js';
import { diffWords, normalizeWord, problemWordText } from '../lib/text-diff.js';
import { issueLabel } from '../lib/labels.js';
import { speak } from '../lib/tts.js';

// 發音評估結果的呈現。Azure 有逐字、逐音素分數；Gemini 退路只有主觀分數。

const ERROR_LABEL = {
  Mispronunciation: '發音不準',
  Omission: '沒有唸到',
  Insertion: '多唸了',
  UnexpectedBreak: '中間多了停頓',
  MissingBreak: '少了該有的停頓',
  Monotone: '語調太平',
};

function scoreLevel(v) {
  if (typeof v !== 'number') return 'na';
  if (v >= 80) return 'good';
  if (v >= 60) return 'ok';
  return 'bad';
}

/**
 * Azure 的 Words 對齊到畫面上的目標句。
 * Azure 回的字沒有標點，且 enableMiscue 會產生 Insertion（多唸的字），
 * 所以不能用索引直接對應 —— 用雙指標按字面比對。
 */
function alignAzureWords(targetWords, azureWords) {
  const usable = (azureWords ?? []).filter((w) => w.errorType !== 'Insertion');
  const out = new Array(targetWords.length).fill(null);
  let j = 0;
  for (let i = 0; i < targetWords.length; i++) {
    const t = normalizeWord(targetWords[i]);
    let k = j;
    while (k < usable.length && normalizeWord(usable[k].word) !== t) k++;
    if (k < usable.length) { out[i] = usable[k]; j = k + 1; }
  }
  return out;
}

function buildHighlightedSentence(targetText, data) {
  const targetWords = targetText.split(/\s+/);
  const el = h('p', { class: 'sentence', id: 'sentence' });

  const aligned = data.provider === 'azure' ? alignAzureWords(targetWords, data.words) : null;
  // Gemini 退路的逐字比對用 lib/text-diff.js —— 那份是純函式而且有單元測試，
  // 不要在這裡再寫一份 LCS（原本兩邊各有一份，改一邊另一邊就會不一致）
  const diffed = data.provider !== 'azure'
    ? diffWords(targetText, data.transcript ?? '', data.problem_words ?? [])
    : null;

  targetWords.forEach((word, idx) => {
    let cls = 'word';
    let title = '';

    if (aligned) {
      const info = aligned[idx];
      cls += ` word--${info ? scoreLevel(info.accuracy) : 'na'}`;
      if (info?.errorType === 'Omission') cls += ' word--omitted';
      if (info) {
        title = `準確度 ${info.accuracy}` +
          (info.errorType && info.errorType !== 'None' ? `・${ERROR_LABEL[info.errorType] ?? info.errorType}` : '');
      }
    } else if (diffed?.[idx]?.miss) {
      cls += ' word--bad';
      title = diffed[idx].reason === 'unheard'
        ? '這個字沒有聽到，或唸得不一樣'
        : '這個字的發音需要加強';
    }

    append(el, h('span', { class: cls, title: title || null }, word));
    if (idx < targetWords.length - 1) append(el, ' ');
  });

  return el;
}

function scoreTile(label, value, hint) {
  return h('div', { class: `tile tile--${scoreLevel(value)}`, title: hint || null },
    h('div', { class: 'tile__value' }, typeof value === 'number' ? String(Math.round(value)) : '—'),
    h('div', { class: 'tile__label' }, label),
  );
}

/**
 * Gemini 路徑的逐字發音問題：唸成什麼、屬於哪一類、嘴巴該怎麼做。
 *
 * 只說「thoroughly 發音不準」對練習沒有幫助 —— 使用者不知道自己唸成了什麼，
 * 也不知道要怎麼改。Azure 路徑有逐音素分數所以不需要這一段（見上面的 worddetail），
 * 這裡是沒設定 Azure 時的替代方案。
 *
 * @returns {HTMLElement|null} 沒有問題字時回 null（不要留一個空的區塊）
 */
function geminiProblemWords(list) {
  const items = (Array.isArray(list) ? list : [])
    .map((item) => (typeof item === 'string' ? { word: item } : item))
    .filter((item) => problemWordText(item));
  if (items.length === 0) return null;

  const wrap = h('div', { class: 'problems' },
    h('p', { class: 'problems__title' }, '這幾個字可以再練'));
  const rows = h('ul', { class: 'problems__list' });

  for (const item of items) {
    const row = h('li', { class: 'problems__item' },
      h('div', { class: 'problems__head' },
        h('span', { class: 'problems__word' }, item.word),
        h('span', { class: 'chip chip--issue' }, issueLabel(item.issue)),
        // 單字放慢一點 —— 這裡的目的是聽清楚那個音，不是聽自然的語速
        h('button', {
          class: 'btn btn--ghost btn--small problems__play',
          title: `聽 ${item.word} 的發音`,
          onclick: () => speak(item.word, { rate: 0.75 }).catch(() => {}),
        }, '🔊 單字'),
      ));

    // 「你唸成什麼」只在確實不一樣時才寫；一樣的話那行字只會讓人困惑
    if (item.heard && item.heard.toLowerCase() !== item.word.toLowerCase()) {
      append(row, h('p', { class: 'problems__heard' }, `你唸成：${item.heard}`));
    }
    if (item.tip_zh) append(row, h('p', { class: 'problems__tip' }, item.tip_zh));
    append(rows, row);
  }

  append(wrap, rows);
  return wrap;
}

/**
 * @param {HTMLElement} container 講評要放進去的容器
 * @param {object} data /api/pronunciation-feedback 的回應
 * @param {string} targetText 目標句
 * @param {(el: HTMLElement) => void} replaceSentence 用標色版本換掉畫面上的句子
 */
export function renderAssessment(container, data, targetText, replaceSentence) {
  replaceSentence?.(buildHighlightedSentence(targetText, data));

  if (data.provider === 'azure') {
    const s = data.scores ?? {};
    append(container, 
      h('div', { class: 'overall' },
        h('span', { class: 'overall__value' }, typeof s.pronunciation === 'number' ? String(Math.round(s.pronunciation)) : '—'),
        h('span', { class: 'overall__max' }, '/ 100'),
        h('span', { class: 'overall__label' }, '發音總分'),
      ),
      h('div', { class: 'tiles' },
        scoreTile('準確度', s.accuracy, '個別音發得準不準'),
        scoreTile('流暢度', s.fluency, '字與字之間的停頓是否自然'),
        scoreTile('完整度', s.completeness, '有沒有漏字'),
        scoreTile('語調', s.prosody, '重音、語調、語速與節奏'),
      ),
      h('p', { class: 'hint' }, 'Azure Speech 的客觀分數（逐音素分析）。語調評估目前僅支援 en-US。'),
    );

    const problems = (data.words ?? []).filter(
      (w) => (w.errorType && w.errorType !== 'None') || (w.accuracy ?? 100) < 80
    );
    if (problems.length) {
      const wrap = h('div', { class: 'worddetail' }, h('h3', { class: 'worddetail__title' }, '需要加強的字'));
      for (const w of problems.slice(0, 6)) {
        const row = h('div', { class: 'worddetail__row' },
          h('span', { class: `worddetail__word worddetail__word--${scoreLevel(w.accuracy)}` }, w.word),
          h('span', { class: 'worddetail__meta' },
            (typeof w.accuracy === 'number' ? `${Math.round(w.accuracy)} 分` : '') +
            (w.errorType && w.errorType !== 'None' ? `・${ERROR_LABEL[w.errorType] ?? w.errorType}` : '')),
        );
        const weak = (w.phonemes ?? []).filter((p) => (p.accuracy ?? 100) < 70);
        if (weak.length) {
          append(row, h('span', { class: 'phonemes' },
            weak.map((p) => h('span', { class: `phoneme phoneme--${scoreLevel(p.accuracy)}` },
              `${p.phoneme} ${Math.round(p.accuracy ?? 0)}`))));
        }
        append(wrap, row);
      }
      append(container, wrap);
    }

    if (data.recognizedText) {
      append(container, h('p', { class: 'hint' }, `系統聽到：${data.recognizedText}`));
    }
  } else {
    if (typeof data.score === 'number') {
      append(container, 
        h('div', { class: 'overall' },
          h('span', { class: 'overall__value' }, String(data.score)),
          h('span', { class: 'overall__max' }, '/ 100'),
          h('span', { class: 'overall__label' }, '參考分數'),
        ),
        h('p', { class: 'hint' },
          '這是 AI 的主觀評估，僅供參考，不是標準化測驗分數。設定 Azure 之後會換成客觀的逐音素評分。'),
      );
    }
    if (data.transcript) {
      append(container, h('p', { class: 'hint' }, `AI 聽到的內容：${data.transcript}`));
    }
    append(container, geminiProblemWords(data.problem_words));
  }

  append(container, h('p', { class: 'coach' }, data.feedback_zh ?? '（沒有收到講評內容）'));

  append(container, narrationNote(data));
}

// 講評是誰寫的、為什麼。四種情況要講四句不同的話 ——
// 「你自己關掉的」與「這次沒回來」如果寫成同一句，使用者會以為壞了。
//
// 講評的來源現在不一定是 Gemini（伺服器的 .env 可以指到任何 OpenAI 相容端點），
// 所以這幾句話都不寫死廠商名 —— 實際是誰由回應的 narrationLabel 帶上來。
const NARRATION_NOTE = {
  disabled: '（中文講評已關閉，上面是本地摘要。要更具體的建議可以到「設定」重新開啟。）',
  no_key: '（上面的講評由本地摘要產生 —— 伺服器還沒設定講評用的模型。）',
  failed: '（這次的講評沒有回來，已改用本地摘要。分數不受影響。）',
  gemini_scores: '（沒有設定 Azure 時分數本身就是 Gemini 給的，所以關掉講評不會變快。）',
};

function narrationNote(data) {
  const note = NARRATION_NOTE[data.narrationReason];
  if (note) return h('p', { class: 'hint' }, note);

  // 舊的回應沒有 narrationReason，只有 narrationSource
  if (data.narrationSource === 'local') {
    return h('p', { class: 'hint' }, '（上面的講評由本地摘要產生，沒有呼叫模型）');
  }

  // 有呼叫模型的話把等待時間寫出來 —— 「值不值得等」要看得到才判斷得出來，
  // 也是換了模型之後唯一能比較快慢的地方
  if (data.narrationSource && data.narrationSource !== 'local'
      && typeof data.narrationMs === 'number') {
    const who = data.narrationLabel || 'AI';
    return h('p', { class: 'hint' },
      `（講評由 ${who} 產生，等了 ${(data.narrationMs / 1000).toFixed(1)} 秒。` +
      '嫌慢可以到「設定」關掉，分數不受影響。）');
  }

  return null;
}
