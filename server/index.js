import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';

import {
  getPronunciationFeedback,
  GeminiError,
  hasApiKey,
  MODELS,
  defaultModel,
} from './gemini.js';
import { analyseWavPcm16, isSilentRecording } from './audio.js';

// 專案根目錄（server/ 的上一層）。
// §3：.env 放在專案根目錄。這裡明確指定路徑而不是靠 dotenv 的預設值，
// 這樣不論從哪個 cwd 執行 `npm start` 都讀得到，避免踩雷清單 #4。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const PORT = process.env.PORT || 3000;

// 錄音上限。§2.2 的請求上限是 20 MB；16 kHz 單聲道 WAV 每秒約 32 KB，
// 8 MB 已經足夠錄約 4 分鐘，遠超過一句練習句的需求。
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

const upload = multer({
  // 踩雷清單 #7：Express 不解析 multipart。用 memoryStorage 不落地暫存檔。
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
});

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, geminiConfigured: hasApiKey() });
});

// 前端的 model 選單就是讀這支。清單寫死在後端，前端只能從裡面挑 ——
// 這樣「使用者可以選 model」才不等於「任何字串都能送進 API 呼叫」。
app.get('/api/models', (req, res) => {
  res.json({ models: MODELS, default: defaultModel() });
});

app.get('/api/sentences', (req, res, next) => {
  fs.promises
    .readFile(path.join(ROOT, 'sentences.json'), 'utf8')
    .then((raw) => res.type('application/json').send(raw))
    .catch(next);
});

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

    // 沒有人聲就別送給 Gemini —— flash 系列會把目標句當成聽到的內容並給高分，
    // 見 server/audio.js 開頭的實測紀錄。這一關擋掉後連 API 都不會呼叫。
    const stats = analyseWavPcm16(req.file.buffer);
    if (isSilentRecording(stats)) {
      console.log(
        `[feedback] 判定為無人聲（peak=${stats.peak.toFixed(4)}、` +
          `有聲音框佔比=${(stats.voicedRatio * 100).toFixed(1)}%），未呼叫 Gemini`
      );
      return res.json({
        speech_detected: false,
        transcript: '',
        score: 0,
        problem_words: [],
        feedback_zh:
          '• 這段錄音裡幾乎沒有聲音。\n' +
          '• 請確認麥克風沒有被靜音、系統輸入裝置選對了，並靠近麥克風再錄一次。',
        model: null,
        gated_by: 'silence',
      });
    }
    if (!stats.analysed) {
      console.warn(`[feedback] 無法分析音訊能量（${stats.reason}），略過無人聲檢查`);
    }

    const startedAt = Date.now();
    try {
      const result = await getPronunciationFeedback({
        audioBuffer: req.file.buffer,
        // 前端一律送 WAV（§2.3）。萬一 mimetype 缺漏就補上預設值。
        mimeType: req.file.mimetype?.startsWith('audio/')
          ? req.file.mimetype
          : 'audio/wav',
        sentence,
        model,
      });

      console.log(
        `[feedback] Gemini（${result.model}）回覆完成，` +
          `耗時 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒，分數 ${result.score}`
      );
      res.json(result);
    } catch (err) {
      if (err instanceof GeminiError) {
        // 完整錯誤已在 gemini.js 裡 log 過，這裡只回安全的中文訊息
        return res
          .status(err.httpStatus)
          .json({ error: err.code, message: err.userMessage });
      }
      throw err;
    }
  }
);

// multer 與其他錯誤的統一處理。訊息一律用繁體中文講清楚使用者該做什麼。
// 踩雷清單 #10：回給前端的訊息不含金鑰或完整 stack。
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
  console.log(`預設 model：${defaultModel()}（可在頁面上切換，或用 .env 的 GEMINI_MODEL 改預設）`);
  console.log('提示：麥克風需要 secure context，請務必用 localhost 開啟，不要用區網 IP。');
  if (!hasApiKey()) {
    console.warn(
      '\n⚠️  找不到 GEMINI_API_KEY —— 送出錄音時會失敗。\n' +
        `   請在 ${path.join(ROOT, '.env')} 填入 GEMINI_API_KEY=你的金鑰，然後重新啟動。\n` +
        '   金鑰申請：https://aistudio.google.com/apikey\n'
    );
  }
});
