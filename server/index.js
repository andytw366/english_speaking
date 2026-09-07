import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';

import {
  getPronunciationFeedback, GeminiError, hasApiKey,
  resetClient as resetGeminiClient, MODELS, defaultModel,
} from './gemini.js';
// 匯入時改名：這個檔案裡已經有一個 `narrate` —— 那是「使用者要不要講評」的布林值。
// 同名的話 handler 裡的 const 會遮住 import，而錯誤是執行期的
// `narrate is not a function`，只有真的送一次錄音才會發現。
import { narrate as generateNarration, narrationProvider } from './narrator.js';
import { analyseWavPcm16, isSilentRecording } from './audio.js';
import { localSummary, wantsNarration } from './narration.js';
import { assessPronunciation, AzureError, hasAzureConfig } from './azure-pronunciation.js';
import {
  readSettings, writeSettings, assertOwner, settingsPath, SettingsError,
} from './settings.js';
import { createStore, StoreError } from './store.js';
import {
  createAuthGate, createAuthRoutes, createSyncRoutes,
} from './routes-auth.js';

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

// 使用者資料放哪。**Docker 裡一定要掛 volume** —— 沒掛的話容器一重建
// 進度就全部消失，而且沒有任何錯誤訊息（見 docker-compose.yml 的 userdata）。
//
// 目錄名刻意不用 `data/`：那個名字已經被手寫的面試練習句佔用
// （`data/interview.txt`，`scripts/import-sentences.mjs` 會讀）。
const DATA_DIR = process.env.DATA_DIR?.trim() || path.join(ROOT, 'userdata');
const store = createStore(DATA_DIR);

// 從設定頁存的金鑰放在 DATA_DIR，不是 .env（理由見 server/settings.js 開頭）。
//
// `override: true` 是刻意的：**這個檔案要蓋掉 .env 與環境變數**。
// 不 override 的話，compose 的 `AZURE_SPEECH_KEY: ${AZURE_SPEECH_KEY:-}` 會把
// 一個**空字串**放進 process.env，而 dotenv 看到「已經有這個鍵」就跳過 ——
// 症狀是在網頁上存了金鑰、伺服器也回「已儲存」，但功能還是說沒設定。
dotenv.config({ path: settingsPath(DATA_DIR), override: true, quiet: true });

const app = express();

// 進度整包上傳會比預設的 1mb 大（srs 全練過約 0.57 MB，加上其餘的鍵）。
// 真正的上限在 store.js 的 MAX_DATA_BYTES，這裡只是別讓 body parser 先擋掉
app.use(express.json({ limit: '12mb' }));

// 靜態檔（HTML / CSS / JS / 圖示）**不擋** —— 擋了的話連登入畫面都載不出來。
// 要擋的是 /api，那才是花錢與存資料的地方
app.use(express.static(path.join(ROOT, 'public')));

app.use('/api/auth', createAuthRoutes(store, { inviteCode: process.env.INVITE_CODE?.trim() ?? '' }));

// 這一行以下的 /api 端點全部要登入（除了 isPublicPath 列的那兩種）
app.use('/api', createAuthGate(store));
app.use('/api/sync', createSyncRoutes(store));

/**
 * 「這台伺服器現在有什麼能力」。設定頁靠它顯示「目前」那一行 ——
 * 換了金鑰卻沒生效時，「畫面上寫的跟實際跑的一樣」是唯一能自己查出問題的方式。
 *
 * 抽成函式是因為存完金鑰的回應也要帶同一份（見 POST /api/settings）：
 * 前端自己從金鑰有沒有設定去推「Azure 通了沒」的話，那個規則就有兩份
 * （Azure 要 key **和** region 都有才算），而分岔的症狀是畫面說得跟實際不一樣。
 */
function healthPayload() {
  return {
    ok: true,
    azureConfigured: hasAzureConfig(),
    geminiConfigured: hasApiKey(),
    narration: narrationProvider(),
  };
}

app.get('/api/health', (req, res) => {
  res.json(healthPayload());
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
  // 只允許已知的檔名形態，避免路徑穿越。
  // band 是依詞頻的級距、tier 是依難度的分級（同一批字的兩種切法），
  // tier-map 是「id 是第幾級」的對照表。新增牌組型態時這裡要跟著加。
  if (!/^(index|curated|band-\d{2}|tier-\d+|tier-map)\.json$/.test(name)) {
    return res.status(404).json({
      error: 'unknown_deck',
      message: `找不到「${name}」這組單字。`,
    });
  }
  fs.promises
    .readFile(path.join(VOCAB_DIR, name), 'utf8')
    .then((raw) => res.type('application/json').send(raw))
    .catch((err) => {
      // 檔名形態合法但檔案不存在（tier-99.json、band-99.json）要回 404，
      // 不要掉進通用錯誤處理變成 500 —— 那個訊息會讓人以為伺服器壞了。
      if (err.code === 'ENOENT') {
        return res.status(404).json({
          error: 'unknown_deck',
          message: `找不到「${name}」這組單字。`,
        });
      }
      next(err);
    });
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
//
// 只有**擁有者**（第一個註冊的帳號）能讀寫金鑰。登入與 Origin 檢查是上面的
// authGate 做的，這裡再加一道「是不是擁有者」。詳見 server/settings.js 開頭
// —— 那裡也寫了為什麼這一關以前是「只放行 loopback」、現在換掉了。
app.get('/api/settings', async (req, res) => {
  try {
    assertOwner(req.user, await store.owner());
    res.json(readSettings());
  } catch (err) {
    handleSettingsError(err, res);
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    assertOwner(req.user, await store.owner());
    const updated = writeSettings(DATA_DIR, req.body ?? {});
    // Gemini 的 client 會把金鑰記在自己身上，換了金鑰要把它丟掉重建 ——
    // 不然新金鑰要等重啟才生效。其他幾個（Azure、講評端點）每次呼叫都重讀
    // process.env，不需要處理
    if (updated.includes('GEMINI_API_KEY')) resetGeminiClient();
    console.log(`[settings] ${req.user.username} 已更新：${updated.join(', ')}`);
    // 一起回「現在有什麼能力」——存完之後設定頁那一行要馬上對，
    // 不然使用者會以為沒生效而重複儲存
    res.json({ ok: true, updated, settings: readSettings(), health: healthPayload() });
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
    message: `寫入設定失敗。請確認 ${settingsPath(DATA_DIR)} 所在的目錄可寫入，` +
      '詳細原因請看伺服器 console。',
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

    // 使用者可以在「設定」關掉中文講評。關掉之後 Azure 的分數照樣回傳，
    // 只是講評改用本地摘要 —— 省下的就是等 Gemini 那幾秒。
    // 沒送這個欄位視為「要」，舊前端的行為不變。
    const narrate = wantsNarration(req.body?.narrate);

    console.log(
      `[feedback] 收到錄音：${req.file.mimetype}，` +
        `${(req.file.size / 1024).toFixed(1)} KB，model：${model ?? defaultModel()}，` +
        `中文講評：${narrate ? '要' : '關閉'}，` +
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

        // 講評失敗不讓整個請求失敗 —— 分數本身已經有價值。
        // 使用者關掉講評時連呼叫都不做，這是這個開關唯一的意義：省掉那段等待。
        let narration = null;
        let narrationMs = null;
        let narrationReason = null;

        if (!narrate) {
          narrationReason = 'disabled';
        } else {
          const narrationStartedAt = Date.now();
          narration = await generateNarration(assessment, { model });
          narrationMs = Date.now() - narrationStartedAt;
          // narrate() 對「沒設定」與「呼叫失敗」都回 null，但這兩件事
          // 該給使用者看的說明不一樣，所以在這裡分開。
          if (!narration) narrationReason = narrationProvider().ready ? 'failed' : 'no_key';
        }

        console.log(
          `[feedback] Azure 評估完成，耗時 ${elapsed()}，` +
            `總分 ${assessment.scores.pronunciation}，` +
            `講評來源 ${narration
              ? `${narrationProvider().label}（${(narrationMs / 1000).toFixed(1)} 秒）`
              : '本地摘要'}` +
            (narrationReason ? `（${narrationReason}）` : '')
        );

        return res.json({
          ...assessment,
          feedback_zh: narration ?? localSummary(assessment, { reason: narrationReason }),
          narrationSource: narration ? narrationProvider().id : 'local',
          // 畫面上要寫「講評由 X 產生，等了 N 秒」，而 X 現在不一定是 Gemini。
          // 前端不該自己去猜 —— 它看不到 .env
          narrationLabel: narrationProvider().label,
          narrationReason,
          // 回傳實際等了多久，讓「值不值得等」這件事在畫面上看得到，
          // 而不是只有「感覺很慢」。
          narrationMs,
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
      // 這條路上分數本身就是 Gemini 給的，關掉講評沒有東西可以省 ——
      // 明講出來，不然使用者會以為開關壞了。
      return res.json({
        provider: 'gemini',
        ...result,
        narrationSource: 'gemini',
        narrationReason: narrate ? null : 'gemini_scores',
      });
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

// multer 與其他錯誤的統一處理。訊息一律用繁體中文講清楚使用者該做什麼。
// 回給前端的訊息不含金鑰或完整 stack。
app.use((err, req, res, next) => {
  if (err instanceof StoreError) {
    console.error('[store]', err);
    return res.status(err.httpStatus).json({ error: 'store', message: err.userMessage });
  }

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

await store.init();

app.listen(PORT, async () => {
  console.log(`口說練習 App 已啟動： http://localhost:${PORT}`);
  console.log('提示：麥克風需要 secure context，請務必用 localhost 開啟，不要用區網 IP。');

  const azure = hasAzureConfig();
  const gemini = hasApiKey();
  const narration = narrationProvider();
  console.log(
    `發音評估：${azure ? 'Azure（客觀分數）' : 'Gemini（主觀分數，未設定 Azure）'}` +
      ` / 中文講評：${narration.ready
        ? `${narration.label}${narration.model ? `（${narration.model}）` : ''}`
        : `本地摘要（${narration.label} ${narration.problem}）`}`
  );

  if (fs.existsSync(settingsPath(DATA_DIR))) {
    // 值可能來自兩個檔案，而「我改了 .env 卻沒生效」只有在知道這件事
    // 之後才查得出來 —— 所以有這個檔案時就講出來
    console.log(`金鑰設定：${settingsPath(DATA_DIR)} 也讀了（設定頁存的會蓋掉 .env）`);
  }

  if (!azure && !gemini) {
    console.warn(
      '\n⚠️  Azure 與 Gemini 都沒有設定 —— 送出錄音一定會失敗。\n' +
        '   用擁有者的帳號登入後到「設定 → API 金鑰」填就好（存了立刻生效，不用重啟），\n' +
        `   或者編輯 ${path.join(ROOT, '.env')} 再重新啟動。\n`
    );
  } else if (!azure) {
    console.warn(
      '\n⚠️  沒有設定 Azure（AZURE_SPEECH_KEY / AZURE_SPEECH_REGION）。\n' +
        '   目前用 Gemini 給主觀分數；設定 Azure 後才有逐音素的客觀評估。\n'
    );
  }

  const users = await store.userCount();
  console.log(`帳號：${users} 個（資料放在 ${DATA_DIR}）`);
  if (users === 0) {
    console.log('   還沒有任何帳號 —— 打開網頁會直接請你建立第一個（那個就是擁有者）。');
  }
  if (!DATA_DIR.startsWith('/data') && process.env.NODE_ENV === 'production') {
    console.warn(
      `\n⚠️  DATA_DIR 是 ${DATA_DIR}。在容器裡跑的話請確認它掛了 volume ——\n` +
        '   沒掛的話重建映像時使用者的全部學習進度會消失，而且不會有錯誤訊息。\n'
    );
  }
});
