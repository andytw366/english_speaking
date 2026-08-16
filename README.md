# 英語口說練習 App（speaking-coach）

本機執行的網頁 App：顯示英文練習句 → 聽示範發音 → 錄下自己唸的版本 → 交給 Gemini 給繁體中文的發音講評。

**目前進度：階段 1～5 已完成。**

階段 5 包含練習紀錄（`localStorage`）、依情境／難度篩選、錄音波形視覺化，
另外加了兩件原本不在規劃裡的東西：**可切換分析用的 Gemini model**，
以及**無人聲偵測**（修掉一個會給出完全錯誤評分的問題，見下方）。

> ✅ **已用真實金鑰端對端驗證過**（2026-08）。
> 成功路徑、五個可選 model、無人聲偵測、白名單擋非法 model 都實測通過。
> 驗證用的語音是拿 Gemini TTS 產生的真人語音樣本，不是合成訊號 ——
> 樣本留在 `test/fixtures/speech-16k.wav`，`npm test` 會用到。

---

## 需求

| 項目 | 需求 |
|---|---|
| Node.js | **>= 20.0.0**（`@google/genai` 2.17.1 的 `engines` 欄位要求）。⚠️ 見下方說明 |
| 瀏覽器 | Chrome / Edge 建議。Safari 可用（錄音格式會是 mp4/aac，程式會自動轉成 WAV） |
| 網址 | **必須用 `http://localhost:3000`** —— 原因見下方「已知限制」 |

> ⚠️ **Node 版本**：`@google/genai` 的 `engines` 要求 `>= 20.0.0`，但 npm 預設不會強制擋，
> 所以在 Node 18 上照樣裝得起來也跑得動（本專案的所有驗證都是在 v18.19.1 上跑完的，
> 沒有遇到問題）。不過那是「剛好能動」，不是官方支援的組合 ——
> SDK 之後改用 Node 20+ 的語法時會無預警壞掉。建議還是升到 Node 20 或 22：
>
> ```bash
> curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
> nvm install 22 && nvm use 22
> ```

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

## 可以選哪些 model

頁面上「分析用的 model」下拉選單可以即時切換，選擇會記在 `localStorage`。
也可以用 `.env` 的 `GEMINI_MODEL` 改預設值（值一樣要在白名單內，否則會警告並退回預設）：

```
GEMINI_MODEL=gemini-3.7-flash
```

清單寫死在後端（`server/gemini.js` 的 `MODELS`），前端只能從裡面挑，
送上來的值也會在後端再驗一次 —— **選單是 UI，不是權限**。
少了這道檢查就等於讓瀏覽器把任意字串塞進 API 呼叫。

| model | 實測延遲 | 備註 |
|---|---|---|
| `gemini-3.7-flash` | 4.3s | 最新 |
| `gemini-3.6-flash` | 4.7s | **預設** |
| `gemini-3.5-flash` | 12.9s | 明顯較慢 |
| `gemini-3.5-flash-lite` | 4.1s | 對無人聲的判斷最嚴格 |
| `gemini-3.1-flash-lite` | 3.8s | 最快，品質較陽春 |

### 為什麼清單這麼短

這份清單是實測出來的，不是照 `ListModels` 抄的 —— `ListModels` 只會告訴你某個 model
支援 `generateContent`，不會告訴你它吃不吃得下音訊、structured output 回不回得了 JSON。
實際拿音訊 + schema 測過之後，被排除的有：

| 被排除的 | 原因 |
|---|---|
| `gemini-3.1-pro-preview`、`gemini-pro-latest` | **免費層直接回 429**。Pro 系列要付費帳戶才用得到，放進選單等於挖坑 |
| `gemini-2.5-flash` | 走 Interactions API 時 `output_text` **不是 JSON**，會觸發 `bad_json` 502 |
| `gemini-2.5-flash-lite` | 回 404「no longer available to new users」 |

要加新 model 進白名單，請先跑過同樣的「音訊 + structured output」測試再加。

---

## 無人聲偵測（為什麼不能相信模型自己判斷）

**踩到的問題：** 送一段完全沒有人聲的錄音進去，模型會把提示裡的目標句
原封不動當成「聽到的內容」回傳，給 95～98 分，還稱讚「雙元音發得相當到位」。

這不是 prompt 沒寫清楚。舊版 prompt 已經明確寫了「幾乎聽不到人聲就給 0 分」，
改版後又加上 `speech_detected` 布林欄位、把判斷步驟拉到最前面、明講「你看得到目標句
但那不是你聽到的內容」—— 用**純數位靜音**（所有樣本都是 0）實測的結果：

| | 3.7-flash | 3.6-flash | 3.5-flash | 3.5-flash-lite | 3.1-flash-lite |
|---|---|---|---|---|---|
| 合成噪音 | ❌ 95 分 | ✅ 0 分 | ❌ 95 分 | ✅ | ✅ |
| 純數位靜音 | ❌ 95 分 | ❌ 98 分 | ❌ 95 分 | ✅ | ✅ |

五個 model 有三個照樣給高分，`speech_detected` 也照樣填 `true`。
**結論：這件事不能交給模型判斷。**

所以改成在呼叫 Gemini 之前，直接用訊號本身判斷（`server/audio.js`）：

| 指標 | 門檻 | 擋掉什麼 |
|---|---|---|
| 峰值 | `< 0.02`（約 -34 dBFS） | 靜音、麥克風沒收到音 |
| 有聲音框佔比 | `< 2%` | 整段幾乎都是空的 |
| 音量變異係數 | `< 0.08` | 音量夠大但從頭到尾不變的嗡嗡聲／電流聲 |

三個指標任一命中就直接回傳「沒聽到人聲」，**完全不呼叫 Gemini**（省一次 API 用量）。
這一關擋掉之後不會計入練習紀錄，也不會顯示成「0 分」——
「沒錄到東西」跟「發音很差」給使用者的訊息完全不同。

門檻是拿**真實語音**校準的，不是拍腦袋定的。真人語音的變異係數實測約 1.19，
穩定正弦波約 0.008，中間差兩個數量級；音量降到原本的 5%（峰值 0.044，很小聲但聽得到）
仍然能通過。`npm test` 會用 `test/fixtures/speech-16k.wav` 驗這件事：

```bash
npm test
```

前端 `public/wav-encoder.js` 有一份等價的檢查，但那份只是為了即時提示與省一次上傳 ——
**後端那份才是把關**，因為前端送什麼上來都不能信。兩邊的門檻值要一起改。

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
| model 不在白名單 | 400 | 前端只送得出清單內的值，這關擋的是繞過 UI 的呼叫 |
| 錄音裡沒有人聲 | 200 | 不算錯誤：回 `speech_detected: false`，不呼叫 Gemini、不計入紀錄 |
| 麥克風權限被拒／找不到裝置／被占用 | — | 前端各自對應不同提示 |
| 瀏覽器不支援 `MediaRecorder`／非 secure context | — | 整頁橫幅提示 |
| `localStorage` 不可用（無痕模式等） | — | 練習紀錄靜默停用，App 其他功能照常 |

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
│   ├── index.js          # Express：靜態檔、/api/health、/api/models、/api/sentences、
│   │                     #   /api/pronunciation-feedback；呼叫 Gemini 前的無人聲把關
│   ├── gemini.js         # 封裝 Gemini 呼叫、model 白名單、structured output schema、錯誤分類
│   └── audio.js          # WAV 能量分析（峰值／有聲比例／音量變異），判斷有沒有人聲
├── test/
│   ├── audio.test.js     # 門檻的回歸測試（不需網路與金鑰）
│   └── fixtures/
│       └── speech-16k.wav  # 真實語音樣本，用來確認門檻不會誤擋真人錄音
└── public/
    ├── index.html
    ├── style.css
    ├── app.js            # 例句、篩選、示範發音、錄音、上傳、講評、練習紀錄
    ├── wav-encoder.js    # 錄音 → 16 kHz 單聲道 WAV，附帶音量分析
    ├── waveform.js       # AnalyserNode 即時波形與音量指示
    └── storage.js        # localStorage 練習紀錄與偏好設定
```

### API

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/health` | 回 `{ ok: true, geminiConfigured: boolean }` |
| GET | `/api/models` | 回 `{ models: [{ id, label, note }], default }` —— 前端 model 選單的來源 |
| GET | `/api/sentences` | 回 `sentences.json` |
| POST | `/api/pronunciation-feedback` | multipart：`audio`（WAV 檔）+ `sentence`（目標句）+ `model`（選填） |

`/api/pronunciation-feedback` 成功時回傳：

```json
{
  "speech_detected": true,
  "transcript": "AI 實際聽到的英文內容",
  "score": 78,
  "problem_words": ["thoroughly", "scheduled"],
  "feedback_zh": "• 條列講評…",
  "model": "gemini-3.6-flash"
}
```

沒偵測到人聲時（HTTP 一樣是 200）：

```json
{
  "speech_detected": false,
  "transcript": "",
  "score": 0,
  "problem_words": [],
  "feedback_zh": "• 這段錄音裡幾乎沒有聲音。…",
  "model": null,
  "gated_by": "silence"
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
- 單次錄音上限 60 秒，上傳上限 8 MB。
- **練習紀錄只存在這台瀏覽器**，換瀏覽器或清掉網站資料就沒了。上限 200 筆，超過會丟掉最舊的。
- **無人聲偵測擋得掉「沒有聲音」，擋不掉「有聲音但不是在唸這句話」。**
  播音樂、講中文、隨便亂唸都會通過門檻進到 Gemini，此時就得靠模型判斷 ——
  實測模型在**有實際語音**的情況下判斷是準的（拿正確語音配錯誤目標句測，會誠實回報不符並給低分），
  出問題的只有完全沒有音訊內容的情形，而那一種已經被門檻擋掉了。
- Pro 系列 model 需要付費帳戶，免費層會回 429，所以沒有放進選單。

---

## 在 WSL 上開發

建議把專案放在 **WSL 自己的檔案系統**（例如 `~/english_speaking`），
不要放在 `/mnt/c/...` —— `node_modules` 在 Windows 掛載點上讀寫會慢很多。

WSL2 有 localhost 轉發，所以在 WSL 裡 `npm start`、用 Windows 的瀏覽器開
`http://localhost:3000`，瀏覽器會認定這是 localhost，secure context 成立、麥克風可以用。
這點對這個專案很關鍵，因為改用區網 IP 開就會被瀏覽器擋掉麥克風。

## 測試

```bash
npm test
```

`test/audio.test.js` 驗的是無人聲偵測的門檻，用 `node:test`，不需要網路也不需要金鑰。
它同時測兩個方向：**該擋的要擋**（靜音、極低噪音、平穩嗡嗡聲），
以及**真實語音在各種音量下都不可以被擋**（門檻調太嚴造成誤擋，比原本的 bug 更糟）。

正向樣本用的是真實語音而不是合成訊號 —— 合成訊號的能量分布跟真人說話差太多，測不出誤擋。

## 接下來

階段 1～5 都完成了。還可以做的：

- **UI 尚未在瀏覽器實機驗證。** 開發環境沒有可用的瀏覽器，所以階段 5 的前端
  （篩選、波形、練習紀錄、model 選單）只做過靜態檢查與後端 API 的端對端驗證，
  畫面本身要你在 Windows 的瀏覽器開 `http://localhost:3000` 確認一次。
- 練習紀錄目前只有清單與統計，可以加上分數趨勢圖或「重練這句」。
- 目前每次都隨機抽句，可以改成優先抽出分數低的句子。
- 支援其他 AI 供應商（會需要第二組金鑰與另一套錯誤分類，錯誤處理的面積會變兩倍）。
