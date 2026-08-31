import { h, clear, append } from '../lib/dom.js';
import { filterBySettings } from '../lib/settings.js';
import { speak, stop as stopTts, isSupported as ttsSupported } from '../lib/tts.js';

export const meta = { id: 'listening', label: '聽力', icon: '🎧' };

const CATEGORY_LABEL = { work: '職場', daily: '日常', travel: '旅遊', interview: '面試' };
const DIFFICULTY_LABEL = { easy: '簡單', medium: '中等', hard: '困難' };

let items = [];
let current = null;
let answers = [];      // 使用者選的選項索引
let submitted = false;
let showTranscript = false;
let root = null;

export async function mount(container) {
  root = container;
  const res = await fetch('/api/content/listening');
  if (!res.ok) throw new Error(`讀取聽力題失敗（HTTP ${res.status}）`);
  const raw = await res.json();
  items = filterBySettings(raw);
  if (items.length === 0) items = raw;
  pick(items[Math.floor(Math.random() * items.length)]);
  return () => { stopTts(); root = null; };
}

function pick(item) {
  current = item;
  answers = new Array(item.questions.length).fill(null);
  submitted = false;
  showTranscript = false;
  render();
}

function render() {
  if (!root || !current) return;
  clear(root);

  append(root, 
    h('div', { class: 'card' },
      h('div', { class: 'card__meta' },
        h('span', { class: 'chip' }, CATEGORY_LABEL[current.category] ?? current.category),
        h('span', { class: 'chip chip--muted' }, DIFFICULTY_LABEL[current.difficulty] ?? current.difficulty),
      ),
      h('h2', { class: 'listen__title' }, current.title),
      h('p', { class: 'hint' }, '先聽，再作答。可以重複播放。'),

      h('div', { class: 'row' },
        ttsSupported()
          ? h('button', { class: 'btn btn--primary', id: 'btn-play', onclick: play }, '▶️ 播放')
          : h('p', { class: 'hint' }, '這個瀏覽器不支援語音合成，請改用 Chrome 或 Edge。'),
        h('button', { class: 'btn btn--ghost', onclick: nextItem }, '🔀 換一題'),
      ),

      (submitted || showTranscript)
        ? h('div', { class: 'transcript' },
            h('p', { class: 'card__title' }, '原文'),
            h('p', {}, current.transcript))
        : h('button', {
            class: 'btn btn--link',
            onclick: () => { showTranscript = true; render(); },
          }, '聽不出來？顯示原文'),
    ),
  );

  const qCard = h('div', { class: 'card' }, h('p', { class: 'card__title' }, '理解測驗'));

  current.questions.forEach((q, qi) => {
    const opts = q.options.map((text, oi) => {
      const chosen = answers[qi] === oi;
      const isAnswer = q.answer === oi;
      let cls = 'option';
      if (submitted) {
        if (isAnswer) cls += ' option--correct';
        else if (chosen) cls += ' option--wrong';
      } else if (chosen) cls += ' option--chosen';

      return h('button', {
        class: cls,
        disabled: submitted,
        onclick: () => { answers[qi] = oi; render(); },
      },
        h('span', { class: 'option__mark' }, 'ABCD'[oi]),
        h('span', {}, text),
      );
    });

    append(qCard, 
      h('div', { class: 'question' },
        h('p', { class: 'question__text' }, `${qi + 1}. ${q.question}`),
        h('div', { class: 'options' }, opts),
        submitted && h('p', {
          class: `explain ${answers[qi] === q.answer ? 'explain--correct' : 'explain--wrong'}`,
        }, (answers[qi] === q.answer ? '✅ 答對了：' : '❌ 正解是 ' + 'ABCD'[q.answer] + '：') + q.explain_zh),
      ),
    );
  });

  if (!submitted) {
    const unanswered = answers.filter((a) => a === null).length;
    append(qCard, 
      h('div', { class: 'row' },
        h('button', {
          class: 'btn btn--primary',
          disabled: unanswered > 0,
          onclick: () => { submitted = true; render(); },
        }, '對答案'),
        unanswered > 0 && h('span', { class: 'hint' }, `還有 ${unanswered} 題沒作答`),
      ),
    );
  } else {
    const correct = answers.filter((a, i) => a === current.questions[i].answer).length;
    append(qCard, 
      h('div', { class: 'result' },
        h('p', { class: 'result__score' }, `答對 ${correct} / ${current.questions.length} 題`),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => pick(current) }, '再做一次'),
          h('button', { class: 'btn btn--primary', onclick: nextItem }, '下一題'),
        ),
      ),
    );
  }

  append(root, qCard);
}

async function play() {
  const btn = root?.querySelector('#btn-play');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '🔊 播放中…';
  try {
    await speak(current.transcript, { rate: 0.95 });
  } catch (err) {
    console.error('[tts]', err);
    btn.textContent = '⚠️ 播放失敗';
    setTimeout(() => { btn.textContent = '▶️ 播放'; btn.disabled = false; }, 2000);
    return;
  }
  btn.textContent = '▶️ 再播一次';
  btn.disabled = false;
}

function nextItem() {
  stopTts();
  let next = current;
  while (items.length > 1 && next.id === current.id) {
    next = items[Math.floor(Math.random() * items.length)];
  }
  pick(next);
}
