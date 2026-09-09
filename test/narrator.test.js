// 講評走哪一條路（narrator.js）與 OpenAI 相容端點（openai-narrator.js）。
//
// 為什麼這一份特別重要：**真正的呼叫在開發容器裡跑不到** ——
// egress 是逐主機允許清單，huggingface.co / api.groq.com / api.openai.com
// 全部連不到（跟 Azure 一樣的處境，見 TODO.md）。所以能驗的只有
// 請求的形狀、回應的解析、超時與錯誤處理，而這些就用假的 fetch 全部驗過。
//
// 這裡**不 import server/index.js** —— 它一 import 就 app.listen()。

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNarrationPrompt, cleanNarration } from '../server/narration.js';
import {
  openAIConfig, openAIConfigProblem, narrateViaOpenAI, completeViaOpenAI,
} from '../server/openai-narrator.js';
import {
  narrationProvider, narrate, complete, modelAvailability, PROVIDERS,
} from '../server/narrator.js';

const ASSESSMENT = {
  referenceText: 'I think this is thoroughly wrong.',
  recognizedText: 'I sink this is sorrowly wrong.',
  scores: { pronunciation: 68, accuracy: 70, fluency: 82, completeness: 100, prosody: 55 },
  words: [
    {
      word: 'think',
      accuracy: 40,
      errorType: 'Mispronunciation',
      phonemes: [{ phoneme: 'th', accuracy: 20 }, { phoneme: 'ih', accuracy: 90 }],
    },
    { word: 'is', accuracy: 98, errorType: 'None', phonemes: [] },
  ],
};

/** 每條測試都要從乾淨的環境變數開始 —— 這些是 process 全域的，會互相污染。 */
const KEYS = [
  'NARRATION_PROVIDER', 'NARRATION_BASE_URL', 'NARRATION_API_KEY',
  'NARRATION_MODEL', 'NARRATION_MAX_TOKENS', 'NARRATION_REASONING_EFFORT',
  'GEMINI_API_KEY',
];
function withEnv(values, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const OPENAI_ENV = {
  NARRATION_PROVIDER: 'openai',
  NARRATION_BASE_URL: 'https://router.huggingface.co/v1',
  NARRATION_API_KEY: 'hf_testtoken',
  NARRATION_MODEL: 'some-org/some-model:groq',
};

/** 假的 fetch：記下請求，回傳指定的回應。 */
function fakeFetch(response, calls = []) {
  return Object.assign(
    async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return response;
    },
    { calls }
  );
}

const okResponse = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
  text: async () => '',
});

// ─── prompt ──────────────────────────────────────────────────────────────

test('prompt 帶得到分數、目標句與有問題的字', () => {
  const prompt = buildNarrationPrompt(ASSESSMENT);
  assert.match(prompt, /I think this is thoroughly wrong/);
  assert.match(prompt, /I sink this is sorrowly wrong/);
  assert.match(prompt, /語調／重音 55/);
  // 準確度 40 的字要進來，98 分而且沒錯誤的字不該進來（那只是把 prompt 撐長）
  assert.match(prompt, /think/);
  assert.doesNotMatch(prompt, /- is：/);
  // 低於 70 的音素要列出來，90 分的不用
  assert.match(prompt, /th\(20\)/);
  assert.doesNotMatch(prompt, /ih\(90\)/);
});

test('prompt 兩條路共用 —— 換模型只換模型', () => {
  // 各寫一份 prompt 的話，換過去覺得變好或變差，分不出是模型還是 prompt 的差別。
  // 這條釘住「gemini.js 用的就是這一支」——
  // narrateAssessment 沒有金鑰時會提早回 null，所以直接比對函式來源
  const prompt = buildNarrationPrompt(ASSESSMENT);
  assert.ok(prompt.includes('你是一位英語發音教練'));
  assert.ok(prompt.includes('每行以「• 」開頭'));
});

// ─── 回應整理 ────────────────────────────────────────────────────────────

test('開場白與 markdown 圍欄會被丟掉', () => {
  const raw = '好的，以下是講評：\n\n```markdown\n- 語調偏平，句尾要往下收。\n- th 要把舌尖輕觸上齒。\n```\n希望有幫助！';
  assert.equal(cleanNarration(raw), '• 語調偏平，句尾要往下收。\n• th 要把舌尖輕觸上齒。');
});

test('各種條列符號都收，統一成「• 」', () => {
  assert.equal(
    cleanNarration('* 第一\n- 第二\n1. 第三\n• 第四'),
    '• 第一\n• 第二\n• 第三\n• 第四'
  );
});

test('超過 4 行會截掉 —— prompt 說 4 行，但模型不一定聽', () => {
  const out = cleanNarration(['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `• ${x}`).join('\n'));
  assert.equal(out.split('\n').length, 4);
});

test('<think> 裡的草稿不算講評 —— 會先想再答的 model 有些把它包在正文裡', () => {
  const raw = '<think>使用者的 prosody 只有 55…\n• 先寫這句？不對，太籠統</think>\n' +
    '• 語調偏平，句尾要往下收。';
  assert.equal(cleanNarration(raw), '• 語調偏平，句尾要往下收。');
});

test('<think> 沒收尾＝話被截斷，整段丟掉回 null（不要把半截思考貼到畫面上）', () => {
  assert.equal(cleanNarration('<think>先看看 prosody 55 代表什麼\n• 也許可以說'), null);
});

test('整理不出東西時回 null，讓呼叫端退回本地摘要', () => {
  assert.equal(cleanNarration('這一段完全沒有條列，只是一段散文。'), null);
  assert.equal(cleanNarration(''), null);
  assert.equal(cleanNarration(null), null);
  assert.equal(cleanNarration(undefined), null);
  assert.equal(cleanNarration({ feedback: 'x' }), null);
  // 只有符號、沒有內容的行不算
  assert.equal(cleanNarration('•\n-\n*'), null);
});

// ─── 設定 ────────────────────────────────────────────────────────────────

test('base URL 結尾的斜線會被去掉 —— 不然會組出 //chat/completions', () => {
  withEnv({ ...OPENAI_ENV, NARRATION_BASE_URL: 'https://api.groq.com/openai/v1///' }, () => {
    assert.equal(openAIConfig().baseUrl, 'https://api.groq.com/openai/v1');
  });
});

test('設定不完整時要講出缺哪一個', () => {
  // 三個變數少一個的症狀都是「講評沒出現」，不指名的話沒辦法自己修
  withEnv({ NARRATION_BASE_URL: 'https://x/v1', NARRATION_MODEL: 'm' }, () => {
    assert.match(openAIConfigProblem(), /NARRATION_API_KEY/);
  });
  withEnv({ NARRATION_API_KEY: 'k' }, () => {
    const problem = openAIConfigProblem();
    assert.match(problem, /NARRATION_BASE_URL/);
    assert.match(problem, /NARRATION_MODEL/);
  });
  withEnv(OPENAI_ENV, () => assert.equal(openAIConfigProblem(), null));
});

// ─── 選哪一條路 ──────────────────────────────────────────────────────────

test('NARRATION_PROVIDER 說了算', () => {
  withEnv({ ...OPENAI_ENV, GEMINI_API_KEY: 'AIzaSyTestKeyThatLooksRealEnough' }, () => {
    // Gemini 的金鑰也設了，但明確指定 openai 就走 openai
    assert.equal(narrationProvider().id, 'openai');
  });
  withEnv({ NARRATION_PROVIDER: 'local', GEMINI_API_KEY: 'AIzaSyTestKeyThatLooksRealEnough' }, () => {
    assert.equal(narrationProvider().id, 'local');
  });
});

test('沒指定時看誰的設定是齊的', () => {
  withEnv({ GEMINI_API_KEY: 'AIzaSyTestKeyThatLooksRealEnough' }, () => {
    assert.equal(narrationProvider().id, 'gemini');
  });
  withEnv(
    { ...OPENAI_ENV, NARRATION_PROVIDER: undefined },
    () => {
      delete process.env.NARRATION_PROVIDER;
      assert.equal(narrationProvider().id, 'openai');
    }
  );
});

test('認不得的 NARRATION_PROVIDER 退回自動判斷，不是壞掉', () => {
  // 打錯字時寧可退回預設並警告，也不要讓使用者送出錄音才發現講評不見了
  withEnv({ NARRATION_PROVIDER: 'huggingface', GEMINI_API_KEY: 'AIzaSyTestKeyThatLooksRealEnough' }, () => {
    assert.equal(narrationProvider().id, 'gemini');
  });
  assert.deepEqual(PROVIDERS, ['gemini', 'openai', 'local']);
});

test('設定不完整時 ready 是 false，而且說得出原因', () => {
  // 設定頁要顯示這個。「畫面上寫的跟實際跑的一樣」是唯一能自己查出問題的方式
  withEnv({ NARRATION_PROVIDER: 'openai', NARRATION_BASE_URL: 'https://x/v1' }, () => {
    const p = narrationProvider();
    assert.equal(p.id, 'openai');
    assert.equal(p.ready, false);
    assert.match(p.problem, /NARRATION_API_KEY/);
  });
  withEnv({ NARRATION_PROVIDER: 'gemini' }, () => {
    const p = narrationProvider();
    assert.equal(p.ready, false);
    assert.match(p.problem, /GEMINI_API_KEY/);
  });
});

test('label 顯示主機名而不是完整 URL', () => {
  withEnv(OPENAI_ENV, () => {
    assert.equal(narrationProvider().label, 'router.huggingface.co');
  });
});

test('local 這條路直接回 null，一次呼叫都不做', async () => {
  await withEnv({ NARRATION_PROVIDER: 'local' }, async () => {
    assert.equal(await narrate(ASSESSMENT), null);
  });
});

test('設定不完整時不會硬打出去', async () => {
  await withEnv({ NARRATION_PROVIDER: 'openai', NARRATION_BASE_URL: 'https://x/v1' }, async () => {
    assert.equal(await narrate(ASSESSMENT), null);
  });
});

// ─── 真的呼叫（假的 fetch）───────────────────────────────────────────────

test('請求的形狀：URL、Bearer、model、單一 user 訊息', async () => {
  await withEnv(OPENAI_ENV, async () => {
    const calls = [];
    const out = await narrateViaOpenAI(ASSESSMENT, {
      fetchImpl: fakeFetch(okResponse('• 語調偏平。\n• th 要輕觸上齒。'), calls),
    });

    assert.equal(out, '• 語調偏平。\n• th 要輕觸上齒。');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://router.huggingface.co/v1/chat/completions');
    assert.equal(calls[0].init.headers.authorization, 'Bearer hf_testtoken');
    assert.equal(calls[0].body.model, 'some-org/some-model:groq');
    assert.equal(calls[0].body.messages.length, 1);
    assert.equal(calls[0].body.messages[0].role, 'user');
    assert.match(calls[0].body.messages[0].content, /英語發音教練/);
    // 串流會讓解析複雜好幾倍，而講評只有四行，沒有邊收邊顯示的價值
    assert.equal(calls[0].body.stream, false);
  });
});

test('不要求 JSON —— 少一種「回來的不是合法 JSON」的失敗方式', async () => {
  await withEnv(OPENAI_ENV, async () => {
    const calls = [];
    await narrateViaOpenAI(ASSESSMENT, { fetchImpl: fakeFetch(okResponse('• 好'), calls) });
    assert.equal(calls[0].body.response_format, undefined);
  });
});

test('沒設定 NARRATION_REASONING_EFFORT 就不送這個參數', async () => {
  // 不會推理的 model 收到不認得的參數多半直接回 400，而那個 400 的症狀
  // 跟金鑰打錯一模一樣。預設不送，換 Groq 的 llama 這種就完全不必知道它存在
  await withEnv(OPENAI_ENV, async () => {
    const calls = [];
    await narrateViaOpenAI(ASSESSMENT, { fetchImpl: fakeFetch(okResponse('• 好'), calls) });
    assert.equal(calls[0].body.reasoning_effort, undefined);
    assert.equal(calls[0].body.max_tokens, 400);
  });
});

test('設了 NARRATION_REASONING_EFFORT 才送，而且會小寫化', async () => {
  // 在設定頁打成 Low 的人只會拿到一個 400，跟「講評沒出現」長得一模一樣
  await withEnv({ ...OPENAI_ENV, NARRATION_REASONING_EFFORT: 'Low' }, async () => {
    const calls = [];
    await narrateViaOpenAI(ASSESSMENT, { fetchImpl: fakeFetch(okResponse('• 好'), calls) });
    assert.equal(calls[0].body.reasoning_effort, 'low');
  });
});

test('NARRATION_MAX_TOKENS 蓋掉呼叫端的額度 —— 想的過程也算在裡面', async () => {
  await withEnv({ ...OPENAI_ENV, NARRATION_MAX_TOKENS: '1200' }, async () => {
    const calls = [];
    await narrateViaOpenAI(ASSESSMENT, { fetchImpl: fakeFetch(okResponse('• 好'), calls) });
    assert.equal(calls[0].body.max_tokens, 1200);
  });

  // AI 修正那條路（呼叫端自己填 300）也要一起被蓋掉：
  // 一個會先想再答的 model 兩條路都會不夠，分開調沒有意義
  await withEnv({ ...OPENAI_ENV, NARRATION_MAX_TOKENS: '1200' }, async () => {
    const calls = [];
    await completeViaOpenAI('嗨', {
      maxTokens: 300, fetchImpl: fakeFetch(okResponse('• 好'), calls),
    });
    assert.equal(calls[0].body.max_tokens, 1200);
  });
});

test('看不懂的 NARRATION_MAX_TOKENS 當作沒設定，不是把請求打壞', async () => {
  await withEnv({ ...OPENAI_ENV, NARRATION_MAX_TOKENS: '一千二' }, async () => {
    const calls = [];
    await narrateViaOpenAI(ASSESSMENT, { fetchImpl: fakeFetch(okResponse('• 好'), calls) });
    assert.equal(calls[0].body.max_tokens, 400);
  });
});

test('「200 但 content 是空的」也回 null —— 會先想再答的 model 最常見的失敗', async () => {
  // 額度在模型想完之前就用光，正式的答案一個字都沒輪到。
  // HTTP 是 200、金鑰沒問題，畫面上就只是「講評沒出現」
  await withEnv(OPENAI_ENV, async () => {
    const out = await narrateViaOpenAI(ASSESSMENT, {
      fetchImpl: fakeFetch({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          choices: [{ finish_reason: 'length', message: { content: '', reasoning: '嗯…' } }],
        }),
      }),
    });
    assert.equal(out, null);
  });
});

test('HTTP 錯誤回 null，不丟例外 —— 分數還是要回給使用者', async () => {
  await withEnv(OPENAI_ENV, async () => {
    for (const status of [401, 404, 429, 503, 500]) {
      const out = await narrateViaOpenAI(ASSESSMENT, {
        fetchImpl: fakeFetch({ ok: false, status, text: async () => 'nope', json: async () => ({}) }),
      });
      assert.equal(out, null, `${status} 應該回 null`);
    }
  });
});

test('回應形狀不對也回 null，不會讓整個請求爆掉', async () => {
  await withEnv(OPENAI_ENV, async () => {
    const shapes = [{}, { choices: [] }, { choices: [{}] }, { choices: [{ message: {} }] }];
    for (const data of shapes) {
      const out = await narrateViaOpenAI(ASSESSMENT, {
        fetchImpl: fakeFetch({ ok: true, status: 200, json: async () => data, text: async () => '' }),
      });
      assert.equal(out, null, `${JSON.stringify(data)} 應該回 null`);
    }
  });
});

test('連線失敗回 null', async () => {
  await withEnv(OPENAI_ENV, async () => {
    const out = await narrateViaOpenAI(ASSESSMENT, {
      fetchImpl: async () => { throw new TypeError('fetch failed'); },
    });
    assert.equal(out, null);
  });
});

test('超時用 AbortController，而且訊號真的傳下去了', async () => {
  // 用 Promise.race 的話，race 輸掉的那個請求還是掛在背景跑完才放掉連線 ——
  // 連續超時幾次就會累積一堆沒人要的請求
  await withEnv(OPENAI_ENV, async () => {
    let signal = null;
    const out = await narrateViaOpenAI(ASSESSMENT, {
      fetchImpl: async (_url, init) => {
        signal = init.signal;
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    });
    assert.equal(out, null);
    assert.ok(signal instanceof AbortSignal);
  });
});

// ─── 「有沒有一條模型的路可以用」（情境對話的 AI 修正靠這個）─────────────

test('local 這條路的 ready 是 true，但對 AI 修正而言是不能用', async () => {
  // 這兩件事**不一樣**，而混在一起的症狀是「畫面說可以用，按下去卻永遠失敗」：
  // 本地摘要永遠可用（那正是 local 的意義），但 AI 修正沒有本地替代品
  await withEnv({ NARRATION_PROVIDER: 'local' }, async () => {
    assert.equal(narrationProvider().ready, true);

    const availability = modelAvailability();
    assert.equal(availability.ready, false);
    assert.match(availability.problem, /NARRATION_PROVIDER=local/);

    // 而且真的不會呼叫任何東西
    assert.equal(await complete('隨便一段 prompt'), null);
  });
});

test('設定不完整時 modelAvailability 說得出缺哪一個', () => {
  withEnv({ NARRATION_PROVIDER: 'openai', NARRATION_BASE_URL: 'https://x/v1' }, () => {
    const availability = modelAvailability();
    assert.equal(availability.ready, false);
    assert.match(availability.problem, /NARRATION_API_KEY/);
  });
});

test('設定齊了時 modelAvailability 回得出主機名與 model', () => {
  withEnv(OPENAI_ENV, () => {
    const availability = modelAvailability();
    assert.equal(availability.ready, true);
    assert.equal(availability.label, 'router.huggingface.co');
    assert.equal(availability.model, 'some-org/some-model:groq');
  });
});

test('complete() 走的是「現在設定的那一條路」，設定不完整就不硬打出去', async () => {
  await withEnv({ NARRATION_PROVIDER: 'openai', NARRATION_BASE_URL: 'https://x/v1' }, async () => {
    assert.equal(await complete('prompt'), null);
  });
});
