# 英語口說練習 App（speaking-coach）

本機執行的網頁 App：顯示英文練習句 → 聽示範發音 → 錄下自己唸的版本 → 交給 Gemini 給繁體中文的發音講評。

**目前進度：階段 1（骨架）與階段 2（錄音）已完成。** 後端的 `/api/pronunciation-feedback`
現在回的是假資料，還沒接上 Gemini —— 那是階段 3 的工作。請先照下面「階段 2 驗收」實測一次。

---

## 需求

| 項目 | 需求 |
|---|---|
| Node.js | **>= 20.0.0**（`@google/genai` 2.17.1 的 `engines` 欄位要求；開發時用 v22 驗證過） |
| 瀏覽器 | Chrome / Edge 建議。Safari 可用（錄音格式會是 mp4/aac，程式會自動轉成 WAV） |
| 網址 | **必須用 `http://localhost:3000`** —— 原因見下方「已知限制」 |

## 安裝與啟動

```bash
npm install

# 設定金鑰（階段 3 才會真的用到，階段 2 不填也能跑）
cp .env.example .env
# 編輯 .env，把 GEMINI_API_KEY 換成你的金鑰

npm start
```

開啟 <http://localhost:3000>。

### 怎麼拿 Gemini 金鑰

1. 到 <https://aistudio.google.com/apikey> 建立 API key
2. 把它填進專案根目錄的 `.env`：

   ```
   GEMINI_API_KEY=AIza...
   ```

`@google/genai` 的 SDK 預設就是讀 `GEMINI_API_KEY` 這個環境變數名稱，不要改名。

> **計費提醒：** Google AI Pro／Ultra 訂閱**不包含** Gemini API 額度 —— 官方文件寫得很明白，
> 訂閱福利只在 Google AI Studio 網頁介面內有效，直接用 API key 呼叫是分開計費的。
> 那個「每月 $10 額度」來自 **Google Developer Program 的 Premium 方案**，要拿到它必須是
> Premium 等級 + 有啟用 Cloud Billing 的 GCP 專案 + 把 API 專案綁到該帳單帳戶。
> **不過 Gemini API 本身有免費層，這個專案用免費層跑就夠了**，不需要為了額度卡住開發。
> 一句 5 秒的練習句約 160 tokens（音訊計費是 32 tokens/秒），成本可以忽略。

### `.env` 的位置

`.env` 放在**專案根目錄**（不是 `server/` 底下）。

`dotenv` 預設是從 process 的 cwd 找 `.env`，所以放在 `server/` 底下、又從根目錄執行 `npm start`
的話會讀不到。這裡在 `server/index.js` 明確指定了根目錄的路徑，所以從任何 cwd 執行都讀得到：

```js
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
```

`.env` 已列在 `.gitignore`，不會被 commit。前端程式碼裡沒有任何金鑰，所有 Gemini 呼叫都在後端。

---

## 階段 2 驗收（請實測這幾項）

1. `npm start`，開 <http://localhost:3000>
2. 按「🔊 播放正確發音」→ 應該聽到英語示範
3. 按「開始錄音」→ 允許麥克風權限 → 唸出那句話 → 按「停止錄音」
4. 播放回放 → **應該聽得到自己的聲音**（播的就是轉換後的 WAV，能聽到就代表轉換是好的）
5. 打開瀏覽器 DevTools 的 Console → 應該看到類似這行：

   ```
   [WAV] 原始錄音 audio/webm;codecs=opus 24.3 KB → WAV 156.2 KB / 4.88 秒 / 16000 Hz 單聲道
   ```

6. 按「送出，取得發音講評」→ 會顯示標著「階段 2 假資料」的回覆，代表前後端串通了

順手測一下錯誤處理：在瀏覽器設定裡把本站的麥克風權限改成「封鎖」，重新整理後按錄音，
應該看到中文的權限說明，而不是一句 error code。

---

## 架構

```
english_speaking/
├── .env                  # 你自己建立（已 gitignore）
├── .env.example
├── .gitignore
├── package.json
├── sentences.json        # 27 句練習句，含 id / text / category / difficulty
├── server/
│   └── index.js          # Express：靜態檔、/api/health、/api/sentences、/api/pronunciation-feedback
└── public/
    ├── index.html
    ├── style.css
    ├── app.js            # 例句、示範發音、錄音、上傳、顯示講評
    └── wav-encoder.js    # 錄音 → 16 kHz 單聲道 WAV
```

### API

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/health` | 回 `{ ok: true }` |
| GET | `/api/sentences` | 回 `sentences.json` |
| POST | `/api/pronunciation-feedback` | multipart：`audio`（WAV 檔）+ `sentence`（目標句）。**目前回假資料** |

### 為什麼錄音要轉成 WAV

Gemini API 的 audio 文件列的支援格式是 `wav / mp3 / aiff / aac / ogg / flac`，
Firebase AI Logic 的輸入需求頁則多列了 `webm` 等格式 —— 兩份官方文件不一致，
而 `audio/webm` 正好是瀏覽器 `MediaRecorder` 的預設輸出格式，落在有爭議的那一邊。

所以這個專案一律在瀏覽器端轉成 `audio/wav` 再送（`public/wav-encoder.js`）：

`MediaRecorder` → `blob.arrayBuffer()` → `decodeAudioData()` → `OfflineAudioContext` 重取樣成
單聲道 16 kHz → 自己寫的 44-byte RIFF header 編成 16-bit PCM WAV。

好處：`audio/wav` 在兩份文件裡都明確支援；不需要 ffmpeg 之類的外部依賴；
16 kHz 單聲道對語音辨識綽綽有餘（每秒約 32 KB，離單次請求 20 MB 上限很遠）；
而且 Safari 的 `MediaRecorder` 吐的是 mp4/aac 而非 webm，走這條路兩邊格式就統一了。

### 為什麼不用 Web Speech API 做辨識

`SpeechRecognition` 只接受**即時**麥克風輸入，介面上沒有任何方式可以餵進錄好的 File / Blob，
所以「錄完再拿去辨識」這條路不存在。而且 Chrome 的實作是送到 Google 伺服器辨識、
MDN 標記為 "Limited availability"、Firefox 支援有問題。

改用的做法（階段 4）：讓 Gemini 在**同一次呼叫**裡一起回傳 transcript 和分數，
一次 API 呼叫解決，跨瀏覽器一致，不需要第二套依賴。

---

## 已知限制

- **必須用 `localhost` 開啟。** `getUserMedia` 需要 secure context；`localhost` 算 secure，
  但用區網 IP（例如 `http://192.168.1.5:3000`）開啟時瀏覽器會直接擋掉麥克風。
  要在手機或其他機器上測試，得先架 HTTPS。
- `speechSynthesis` 的語音品質取決於作業系統安裝的語音包，各平台聽起來會不一樣。
- 目前沒有練習紀錄，重新整理頁面後結果就消失（階段 5 才會做 `localStorage`）。
- 單次錄音上限 60 秒，上傳上限 8 MB。

---

## 接下來

- **階段 3：** 建 `server/gemini.js`，用 `ai.interactions.create()` 把 WAV 送給
  `gemini-3.6-flash`，取得繁體中文講評；針對金鑰無效（401/403）、額度用盡（429）、
  格式不接受（400）、逾時分別給不同的中文提示。
- **階段 4：** 改用 structured output（`response_format`）讓 Gemini 一次回
  `{ transcript, score, problem_words, feedback_zh }`；前端把 transcript 跟目標句做逐字比對標色。
- **階段 5：** `localStorage` 練習紀錄、依情境／難度篩選例句、錄音波形視覺化。
