# 英語口說練習 App（speaking-coach）

本機執行的網頁 App：顯示英文練習句 → 聽示範發音 → 錄下自己唸的版本 → 交給 Gemini 給繁體中文的發音講評。

**目前進度：階段 1～4 已完成。** 階段 5（練習紀錄、分類篩選、波形視覺化）還沒做。

> ⚠️ **階段 3／4 尚未用真實金鑰端對端測過** —— 開發環境沒有可用的 Gemini API 金鑰。
> SDK 的參數形狀（`interactions.create`、音訊 part 的 `data` / `mime_type`、
> `response_format`、`output_text`）都有對照 `@google/genai` 的型別定義確認過，
> 錯誤分類路徑也用無效金鑰實測過（見下方「錯誤處理」），
> 但「成功拿到講評」這條路徑要你填入金鑰後才能驗證。

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

## 錯誤處理

所有失敗情境都會在前端顯示繁體中文的說明，講清楚該做什麼，不會只丟 error code。

| 情境 | HTTP | 說明 |
|---|---|---|
| `.env` 沒有 `GEMINI_API_KEY` | 500 | 伺服器啟動時也會在 console 警告 |
| 金鑰格式不對（沒換掉範例值） | 401 | 送出前先擋掉，不浪費一次 API 呼叫 |
| 金鑰無效 | 400 | **注意：Gemini 對無效金鑰回的是 400 不是 401**，見下方 |
| 額度用盡 | 429 | 提示免費層有每分鐘／每日限制 |
| Gemini 服務異常 | 502 | |
| 逾時（60 秒） | 504 | |
| 錄音檔超過 8 MB | 413 | |
| 麥克風權限被拒／找不到裝置／被占用 | — | 前端各自對應不同提示 |
| 瀏覽器不支援 `MediaRecorder`／非 secure context | — | 整頁橫幅提示 |

> **實測發現：金鑰無效時 Gemini 回的是 HTTP 400，不是 401/403**，而且 SDK 的錯誤訊息裡
> 看不到 `API_KEY_INVALID` 這個原因。所以 400 的訊息會同時提示「可能是金鑰無效」與
> 「可能是音檔問題」兩種可能，而不是只講音檔格式 —— 否則使用者會被引導去查錯方向。
> 另外程式在送出前會先檢查金鑰是不是 `AIza` 開頭，把「忘了換掉 `.env` 範例值」這種
> 最常見的狀況提早擋下來。

完整的錯誤內容只寫進伺服器 console，回給前端的訊息不含金鑰或 stack。

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
│   ├── index.js          # Express：靜態檔、/api/health、/api/sentences、/api/pronunciation-feedback
│   └── gemini.js         # 封裝 Gemini 呼叫、structured output schema、錯誤分類
└── public/
    ├── index.html
    ├── style.css
    ├── app.js            # 例句、示範發音、錄音、上傳、顯示講評
    └── wav-encoder.js    # 錄音 → 16 kHz 單聲道 WAV
```

### API

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/health` | 回 `{ ok: true, geminiConfigured: boolean }` |
| GET | `/api/sentences` | 回 `sentences.json` |
| POST | `/api/pronunciation-feedback` | multipart：`audio`（WAV 檔）+ `sentence`（目標句） |

`/api/pronunciation-feedback` 成功時回傳（階段 4 的 structured output）：

```json
{
  "transcript": "AI 實際聽到的英文內容",
  "score": 78,
  "problem_words": ["thoroughly", "scheduled"],
  "feedback_zh": "• 條列講評…"
}
```

前端拿 `transcript` 跟目標句做 LCS 逐字比對，把沒對上的字、以及 `problem_words` 點名的字標紅。
`score` 在 UI 上明確標示為「參考分數」，並註明是 AI 主觀評估、不是標準化測驗分數。

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

## 在 WSL 上開發

建議把專案放在 **WSL 自己的檔案系統**（例如 `~/english_speaking`），
不要放在 `/mnt/c/...` —— `node_modules` 在 Windows 掛載點上讀寫會慢很多。

WSL2 有 localhost 轉發，所以在 WSL 裡 `npm start`、用 Windows 的瀏覽器開
`http://localhost:3000`，瀏覽器會認定這是 localhost，secure context 成立、麥克風可以用。
這點對這個專案很關鍵，因為改用區網 IP 開就會被瀏覽器擋掉麥克風。

## 接下來（階段 5，還沒做）

- `localStorage` 練習紀錄
- 依情境／難度篩選例句（`sentences.json` 已經有 `category` 與 `difficulty` 欄位）
- 錄音波形視覺化（`AnalyserNode`）
