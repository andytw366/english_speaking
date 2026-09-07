import { h, append } from '../lib/dom.js';
import { columns } from '../lib/layout.js';
import { categoryLabel, difficultyLabel } from '../lib/labels.js';
import { filterBySettings } from '../lib/settings.js';
import { recordPractice, renderDailyCard } from '../lib/daily.js';
import { speak, stop as stopTts, isSupported as ttsSupported } from '../lib/tts.js';
import { bindKeys, indexOfKey } from '../lib/keys.js';

export const meta = { id: 'listening', label: '聽力', icon: '🎧' };


let items = [];
let current = null;
let answers = [];      // 使用者選的選項索引
let submitted = false;
// 這一組算進今天的進度了沒。**跟著題組走，不是跟著 submitted 走** ——
// 「再做一次」會把 submitted 清成 false，拿它判斷的話同一組會被算第二次。
// （中翻英的 `counted` 是同一個理由，README 的雷單裡記過。）
let counted = false;
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
  const unbindKeys = bindKeys(onKey);
  return () => { stopTts(); unbindKeys(); root = null; };
}

function pick(item) {
  current = item;
  counted = false;
  restart();
}

/**
 * 同一組重來。跟 `pick()` 的差別只有一個：**不動 `counted`** ——
 * 重做一次不是又練完一組，今天的份不該再加一次。
 */
function restart() {
  answers = new Array(current.questions.length).fill(null);
  submitted = false;
  showTranscript = false;
  render();
}

function render() {
  if (!root || !current) return;
  const { main, side } = columns(root);

  append(side, renderDailyCard('listening'));

  append(main,
    h('div', { class: 'card' },
      h('div', { class: 'card__meta' },
        h('span', { class: 'chip' }, categoryLabel(current.category)),
        h('span', { class: 'chip chip--muted' }, difficultyLabel(current.difficulty)),
      ),
      h('h2', { class: 'listen__title' }, current.title),
      h('p', { class: 'hint' }, '先聽，再作答。可以重複播放。'),

      h('div', { class: 'row' },
        ttsSupported()
          ? h('button', { class: 'btn btn--primary', id: 'btn-play', onclick: play }, '▶️ 播放')
          : h('p', { class: 'hint' }, '這個瀏覽器不支援語音合成，請改用 Chrome 或 Edge。'),
        h('button', { class: 'btn btn--ghost', onclick: nextItem }, '🔀 換一題'),
      ),

      !(submitted || showTranscript) && h('button', {
        class: 'btn btn--link',
        onclick: () => { showTranscript = true; render(); },
      }, '聽不出來？顯示原文'),
    ),
  );

  // 原文放輔助欄：對完答案之後題目與原文可以並排看，不必在兩者之間往回捲
  if (submitted || showTranscript) {
    append(side,
      h('div', { class: 'card' },
        h('p', { class: 'card__title' }, '原文'),
        h('p', { class: 'transcript' }, current.transcript),
      ),
    );
  }

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
          onclick: () => { submitted = true; recordAnswers(); },
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
          h('button', { class: 'btn', onclick: restart }, '再做一次'),
          h('button', { class: 'btn btn--primary', onclick: nextItem }, '下一題'),
        ),
      ),
    );
  }

  append(main, qCard);
}

// ─── 鍵盤 ────────────────────────────────────────────────────────────────
/**
 * `P` 播放、`1`–`4` 作答、Enter 對答案／下一題、`N` 換一題。
 *
 * 一組有好幾題，所以數字鍵**答的是還沒作答的第一題** —— 由上往下 1、2、3
 * 這樣按下去剛好對得起來。全部答完之後數字鍵就沒事做（要改答案還是用滑鼠，
 * 跟畫面上一樣）。
 */
function onKey(key) {
  if (!root || !current) return false;

  if (key === 'p') { root.querySelector('#btn-play')?.click(); return true; }
  if (key === 'n') { nextItem(); return true; }

  if (key === 'enter') {
    if (submitted) { nextItem(); return true; }
    if (answers.every((a) => a !== null)) { submitted = true; recordAnswers(); return true; }
    return false;
  }

  if (submitted) return false;
  const qi = answers.findIndex((a) => a === null);
  if (qi < 0) return false;
  const oi = indexOfKey(key, current.questions[qi].options.length);
  if (oi < 0) return false;
  answers[qi] = oi;
  render();
  return true;
}

/** 對答案。按鈕與 Enter 共用同一份 —— 分兩份寫的話「今天的份」會有一邊忘了記。 */
function recordAnswers() {
  // 今天的份算「答完的題組數」，一組算一次。
  //
  // 原本是照題數算（一組 3 題就 +3），有兩個問題：
  //   1. 每組的題數不一樣（2～6 題），同樣練完一組，數字跳多少要看運氣，
  //      「今天練了 12」講不出練了多少東西；
  //   2. 真正的一個練習單位是「聽一段、把整組答完」，不是單一題 ——
  //      題目是綁在同一段錄音上的，不能分開練。
  // 畫面上的「答對 4 / 6 題」照舊，那是這一組的正確率，跟今天的份是兩回事。
  if (!counted) {
    counted = true;
    recordPractice('listening');
  }
  render();
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
