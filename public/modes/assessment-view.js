import { h } from '../lib/dom.js';

// 發音評估結果的呈現。Azure 有逐字、逐音素分數；Gemini 退路只有主觀分數。

const ERROR_LABEL = {
  Mispronunciation: '發音不準',
  Omission: '沒有唸到',
  Insertion: '多唸了',
  UnexpectedBreak: '中間多了停頓',
  MissingBreak: '少了該有的停頓',
  Monotone: '語調太平',
};

function normalizeWord(w) {
  return w.toLowerCase().replace(/[^a-z0-9']/g, '');
}

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

/** Gemini 退路：用 LCS 找出沒被聽到的字 */
function matchedTargetIndices(targetWords, spokenWords) {
  const a = targetWords.map(normalizeWord);
  const b = spokenWords.map(normalizeWord);
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matched = new Set();
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { matched.add(i); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return matched;
}

function buildHighlightedSentence(targetText, data) {
  const targetWords = targetText.split(/\s+/);
  const el = h('p', { class: 'sentence', id: 'sentence' });

  const aligned = data.provider === 'azure' ? alignAzureWords(targetWords, data.words) : null;
  const matched = data.provider !== 'azure' && data.transcript
    ? matchedTargetIndices(targetWords, data.transcript.split(/\s+/))
    : null;
  const problems = new Set((data.problem_words ?? []).map(normalizeWord).filter(Boolean));

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
    } else if (matched) {
      if (!matched.has(idx) || problems.has(normalizeWord(word))) {
        cls += ' word--bad';
        title = !matched.has(idx) ? '這個字沒有聽到，或唸得不一樣' : '這個字的發音需要加強';
      }
    }

    el.append(h('span', { class: cls, title: title || null }, word));
    if (idx < targetWords.length - 1) el.append(' ');
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
 * @param {HTMLElement} container 講評要放進去的容器
 * @param {object} data /api/pronunciation-feedback 的回應
 * @param {string} targetText 目標句
 * @param {(el: HTMLElement) => void} replaceSentence 用標色版本換掉畫面上的句子
 */
export function renderAssessment(container, data, targetText, replaceSentence) {
  replaceSentence?.(buildHighlightedSentence(targetText, data));

  if (data.provider === 'azure') {
    const s = data.scores ?? {};
    container.append(
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
          row.append(h('span', { class: 'phonemes' },
            weak.map((p) => h('span', { class: `phoneme phoneme--${scoreLevel(p.accuracy)}` },
              `${p.phoneme} ${Math.round(p.accuracy ?? 0)}`))));
        }
        wrap.append(row);
      }
      container.append(wrap);
    }

    if (data.recognizedText) {
      container.append(h('p', { class: 'hint' }, `系統聽到：${data.recognizedText}`));
    }
  } else {
    if (typeof data.score === 'number') {
      container.append(
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
      container.append(h('p', { class: 'hint' }, `AI 聽到的內容：${data.transcript}`));
    }
  }

  container.append(h('p', { class: 'coach' }, data.feedback_zh ?? '（沒有收到講評內容）'));

  if (data.narrationSource === 'local') {
    container.append(h('p', { class: 'hint' }, '（上面的講評由本地摘要產生，未使用 Gemini）'));
  }
}
