import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';

import {
  getPronunciationFeedback, narrateAssessment, GeminiError, hasApiKey,
  resetClient as resetGeminiClient, MODELS, defaultModel,
} from './gemini.js';
import { analyseWavPcm16, isSilentRecording } from './audio.js';
import { assessPronunciation, AzureError, hasAzureConfig } from './azure-pronunciation.js';
import { readSettings, writeSettings, assertLocalRequest, SettingsError } from './settings.js';

// 專案根目錄（server/ 的上一層）。
// .env 放在專案根目錄。這裡明確指定路徑而不是靠 dotenv 的預設值，
// 這樣不論從哪個 cwd 執行 `npm start` 都讀得到。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const PORT = process.env.PORT || 3000;

// 錄音上限。16 kHz 單聲道 WAV 每秒約 32 KB，
// 8 MB 已經足夠錄約 4 分鐘，遠超過一句練習句的需求。
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

const upload = multer({
  // 用 memoryStorage 不落地暫存檔
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
});

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    azureConfigured: hasAzureConfig(),
    geminiConfigured: hasApiKey(),
  });
});

// 可選的 Gemini model。前端的選單從這裡拿，送上來的值也會在 gemini.js 用
// 同一份白名單再驗一次 —— 選單是 UI，不是權限。
app.get('/api/models', (req, res) => {
  res.json({ models: MODELS, default: defaultModel() });
});

// 靜態學習內容。題目與例句是開發時寫好的靜態檔，不做執行期 AI 生成 ——
// 執行期少一個失敗點，也不必為了出題付 API 費用。
const CONTENT_FILES = {
  sentences: 'sentences.json',
  listening: 'listening.json',
  translation: 'translation.json',
  dialogues: 'dialogues.json',
};

// 單字庫拆成多個檔案（精選 + 依詞頻分級的 10 個級距），
// 讓 App 只載入目前要練的那一組，不用一次吃下 3 MB。
const VOCAB_DIR = path.join(ROOT, 'content', 'vocabulary');

app.get('/api/vocabulary/:file', (req, res, next) => {
  const name = req.params.file;
  // 只允許已知的檔名形態，避免路徑穿越
  if (!/^(index|curated|band-\d{2})\.json$/.test(name)) {
    return res.status(404).json({
      error: 'unknown_deck',
      message: `找不到「${name}」這組單字。`,
    });
  }
  fs.promises
    .readFile(path.join(VOCAB_DIR, name), 'utf8')
    .then((raw) => res.type('application/json').send(raw))
    .catch(next);
});

app.get('/api/content/:name', (req, res, next) => {
  const file = CONTENT_FILES[req.params.name];
  if (!file) {
    return res.status(404).json({
      error: 'unknown_content',
      message: `找不到「${req.params.name}」這份學習內容。`,
    });
  }
  fs.promises
    .readFile(path.join(ROOT, 'content', file), 'utf8')
    .then((raw) => res.type('application/json').send(raw))
    .catch(next);
});

// 舊路徑保留，避免既有連結壞掉
app.get('/api/sentences', (req, res) => res.redirect(307, '/api/content/sentences'));

// ─── 設定 ────────────────────────────────────────────────────────────────
// 只允許本機請求：這個端點會寫入伺服器的 .env。詳見 server/settings.js。
app.get('/api/settings', (req, res) => {
  try {
    assertLocalRequest(req);
    res.json(readSettings());
  } catch (err) {
    handleSettingsError(err, res);
  }
});

app.post('/api/settings', (req, res) => {
  try {
    assertLocalRequest(req);
    const updated = writeSettings(ROOT, req.body ?? {});
    if (updated.includes('GEMINI_API_KEY')) resetGeminiClient();
    console.log(`[settings] 已更新：${updated.join(', ')}`);
    res.json({ ok: true, updated, settings: readSettings() });
  } catch (err) {
    handleSettingsError(err, res);
  }
});

function handleSettingsError(err, res) {
  if (err instanceof SettingsError) {
    return res.status(err.httpStatus).json({ error: 'settings', message: err.userMessage });
  }
  console.error('[settings]', err);
  res.status(500).json({
    error: 'settings_failed',
    message: '寫入設定失敗。請確認專案根目錄可寫入，詳細原因請看伺服器 console。',
  });
}

app.post(
  '/api/pronunciation-feedback',
  upload.single('audio'),
  async (req, res) => {
    const sentence = (req.body?.sentence || '').trim();

    if (!req.file) {
      return res.status(400).json({
        error: 'no_audio',
        message: '沒有收到錄音檔，請重新錄一次再送出。',
      });
    }
    if (!sentence) {
      return res.status(400).json({
        error: 'no_sentence',
        message: '沒有收到練習句，請重新整理頁面後再試一次。',
      });
    }

    // model 由前端從 /api/models 的清單挑，沒送就用預設值。
    // 白名單檢查在 gemini.js 裡做（那是唯一擋得住任意字串的地方）。
    const model = (req.body?.model || '').trim() || undefined;

    console.log(
      `[feedback] 收到錄音：${req.file.mimetype}，` +
        `${(req.file.size / 1024).toFixed(1)} KB，model：${model ?? defaultModel()}，` +
        `目標句：「${sentence}」`
    );

    // ─── 送出去之前先擋掉沒有人聲的錄音 ───────────────────────────────
    //
    // 為什麼要在這裡擋：實測把純靜音送給 Gemini，flash 系列會把提示裡的目標句
    // 當成「聽到的內容」原封不動回傳，給 95～98 分還稱讚雙元音很到位
    // （五個 model 有三個這樣，詳見 server/audio.js 開頭的紀錄）。
    // 那個問題改 prompt 修不掉，只能在呼叫前用訊號本身判斷。
    //
    // Azure 對靜音會回 NoMatch（有正確處理），但一樣是白跑一趟 ——
    // 免費層併發數很低，省下來的每一次呼叫都有意義。
    const stats = analyseWavPcm16(req.file.buffer);
    if (isSilentRecording(stats)) {
      console.log(
        `[feedback] 判定為無人聲（peak=${stats.peak.toFixed(4)}、` +
          `有聲音框佔比=${(stats.voicedRatio * 100).toFixed(1)}%），未呼叫任何 API`
      );
      return res.json({
        provider: null,
        speech_detected: false,
        referenceText: sentence,
        recognizedText: '',
        transcript: '',
        score: 0,
        scores: {},
        words: [],
        problem_words: [],
        feedback_zh:
          '• 這段錄音裡幾乎沒有聲音。\n' +
          '• 請確認麥克風沒有被靜音、系統輸入裝置選對了，並靠近麥克風再錄一次。',
        gated_by: 'silence',
      });
    }
    if (!stats.analysed) {
      console.warn(`[feedback] 無法分析音訊能量（${stats.reason}），略過無人聲檢查`);
    }

    const startedAt = Date.now();
    const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`;

    try {
      // ─── 主要路徑：Azure 做客觀評估，Gemini 只負責把數字講成人話 ───
      if (hasAzureConfig()) {
        const assessment = await assessPronunciation({
          audioBuffer: req.file.buffer,
          referenceText: sentence,
        });

        // 講評失敗不讓整個請求失敗 —— 分數本身已經有價值
        const narration = await narrateAssessment(assessment, { model });

        console.log(
          `[feedback] Azure 評估完成，耗時 ${elapsed()}，` +
            `總分 ${assessment.scores.pronunciation}，` +
            `講評來源 ${narration ? 'Gemini' : '本地摘要'}`
        );

        return res.json({
          ...assessment,
          feedback_zh: narration ?? localSummary(assessment),
          narrationSource: narration ? 'gemini' : 'local',
        });
      }

      // ─── 沒設定 Azure 時的退路：純 Gemini（主觀分數）───
      const result = await getPronunciationFeedback({
        audioBuffer: req.file.buffer,
        mimeType: req.file.mimetype?.startsWith('audio/') ? req.file.mimetype : 'audio/wav',
        sentence,
        model,
      });
      console.log(`[feedback] Gemini 回覆完成，耗時 ${elapsed()}，分數 ${result.score}`);
      return res.json({ provider: 'gemini', ...result });
    } catch (err) {
      if (err instanceof AzureError || err instanceof GeminiError) {
        // 完整錯誤已在各自模組裡 log 過，這裡只回安全的中文訊息
        return res
          .status(err.httpStatus)
          .json({ error: err.code, message: err.userMessage });
      }
      throw err;
    }
  }
);

/**
 * 沒有 Gemini 金鑰時，直接用 Azure 的數字組一段中文摘要。
 * 這樣只設定 Azure 也能得到可讀的回饋。
 */
function localSummary(assessment) {
  const s = assessment.scores ?? {};
  const lines = [];

  const dimensions = [
    ['準確度', s.accuracy, '個別音發得準不準'],
    ['流暢度', s.fluency, '字與字之間的停頓是否自然'],
    ['完整度', s.completeness, '有沒有漏字'],
    ['語調', s.prosody, '重音、語調與節奏'],
  ].filter(([, v]) => typeof v === 'number');

  const weakest = dimensions.slice().sort((a, b) => a[1] - b[1])[0];
  if (weakest) {
    lines.push(`• 最需要加強的是「${weakest[0]}」（${Math.round(weakest[1])} 分）—— ${weakest[2]}。`);
  }

  const problems = (assessment.words ?? []).filter(
    (w) => w.errorType !== 'None' || (w.accuracy ?? 100) < 60
  );
  for (const w of problems.slice(0, 3)) {
    const label = {
      Mispronunciation: '發音不準',
      Omission: '沒有唸到',
      Insertion: '多唸了',
      UnexpectedBreak: '中間多了停頓',
      MissingBreak: '少了該有的停頓',
      Monotone: '語調太平',
    }[w.errorType] ?? `準確度偏低（${w.accuracy}）`;

    const weakPhonemes = (w.phonemes ?? [])
      .filter((p) => (p.accuracy ?? 100) < 60)
      .map((p) => p.phoneme);
    lines.push(
      `• 「${w.word}」：${label}` +
        (weakPhonemes.length ? `，特別是 ${weakPhonemes.join('、')} 這幾個音` : '')
    );
  }

  if (problems.length === 0) lines.push('• 每個字都唸得不錯，繼續保持！');
  lines.push('•（設定 GEMINI_API_KEY 之後，這裡會換成更具體的中文教練建議）');

  return lines.join('\n');
}

// multer 與其他錯誤的統一處理。訊息一律用繁體中文講清楚使用者該做什麼。
// 回給前端的訊息不含金鑰或完整 stack。
app.use((err, req, res, next) => {
  console.error('[error]', err);

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'file_too_large',
        message: `錄音檔太大（上限 ${MAX_AUDIO_BYTES / 1024 / 1024} MB），請錄短一點再試一次。`,
      });
    }
    return res.status(400).json({
      error: 'upload_failed',
      message: '上傳錄音時發生問題，請重新錄一次。',
    });
  }

  res.status(500).json({
    error: 'internal',
    message: '伺服器發生非預期的錯誤，請稍後再試一次。詳細原因請看伺服器 console。',
  });
});

app.listen(PORT, () => {
  console.log(`口說練習 App 已啟動： http://localhost:${PORT}`);
  console.log('提示：麥克風需要 secure context，請務必用 localhost 開啟，不要用區網 IP。');

  const azure = hasAzureConfig();
  const gemini = hasApiKey();
  console.log(
    `發音評估：${azure ? 'Azure（客觀分數）' : 'Gemini（主觀分數，未設定 Azure）'}` +
      ` / 中文講評：${gemini ? 'Gemini' : '本地摘要（未設定 Gemini）'}`
  );

  if (!azure && !gemini) {
    console.warn(
      '\n⚠️  Azure 與 Gemini 都沒有設定 —— 送出錄音一定會失敗。\n' +
        `   請編輯 ${path.join(ROOT, '.env')}，至少設定其中一組，然後重新啟動。\n`
    );
  } else if (!azure) {
    console.warn(
      '\n⚠️  沒有設定 Azure（AZURE_SPEECH_KEY / AZURE_SPEECH_REGION）。\n' +
        '   目前用 Gemini 給主觀分數；設定 Azure 後才有逐音素的客觀評估。\n'
    );
  }
});
