# 英語學習練習 App

本機執行的網頁 App，三種練習模式：

| 模式 | 內容 |
|---|---|
| 🗂️ **單字卡** | 40 張單字卡，Leitner 間隔重複排程 |
| 🎧 **聽力** | 10 組情境短文 + 28 道英文理解測驗，用瀏覽器 TTS 朗讀 |
| ✍️ **中翻英** | 20 題，10 題句中填空 + 10 題整句翻譯 |
| 🗣️ **跟讀** | 27 句練習句，聽示範 → 錄音 → 比對；可選用 AI 發音評分 |
| ⚙️ **設定** | API 金鑰、練習範圍篩選、語音與語速、學習資料管理 |

**題目與例句都是預先寫好的靜態檔**（`content/`），執行期不做 AI 生成 ——
少一個失敗點，也不必為了出題付 API 費用。

發音評分是**輔助功能**，不設定任何金鑰也能正常使用其他三種練習。
要用的話：**Azure Speech** 給客觀的逐音素分數，**Gemini** 把分數翻成中文教練建議。

> ⚠️ **Azure 的實際呼叫尚未在開發環境端對端測過** —— 開發環境的 egress policy
> 擋掉了 `*.stt.speech.microsoft.com`。詳見下方「已驗證與未驗證」。

---

## 需求

| 項目 | 需求 |
|---|---|
| Node.js | **>= 20.0.0**（`@google/genai` 2.17.1 的 `engines` 欄位要求；開發時用 v22 驗證過） |
| 瀏覽器 | Chrome / Edge 建議。Safari 可用（錄音格式會是 mp4/aac，程式會自動轉成 WAV） |
| 網址 | **必須用 `http://localhost:3000`** —— 原因見下方「已知限制」 |
| Azure Speech | 發音評估用（選填但建議）—— 見下方設定說明 |
| Gemini | 中文講評用（選填）|

## 安裝與啟動

```bash
npm install

cp .env.example .env
# 編輯 .env 填入金鑰（見下方）。兩組都不填也能啟動，但送出錄音會失敗。

npm start
```

啟動時 console 會告訴你目前用哪一組：

```
發音評估：Azure（客觀分數） / 中文講評：Gemini
```

開啟 <http://localhost:3000>。

### 怎麼拿 Azure Speech 金鑰

1. 到 [Azure 入口網站](https://portal.azure.com) 建立一個「語音服務 (Speech service)」資源
2. 資源建好後在「金鑰與端點」頁面複製 **KEY 1** 與 **位置/區域**
3. 填進 `.env`：

   ```
   AZURE_SPEECH_KEY=你的金鑰
   AZURE_SPEECH_REGION=eastasia
   ```

`AZURE_SPEECH_REGION` 必須跟你建立資源時選的區域一致（例如 `eastasia`、`japaneast`、
`westus`），填錯會得到認證失敗的錯誤。

> **計費（請自行確認最新數字）：** 搜尋到的資料是即時語音轉文字 $1/小時，
> 發音評估再加 $0.30/小時，合計約 $1.30/小時。換算下來一句 5 秒的練習約 $0.0018，
> 大約 550 次練習 1 美元。**這個數字沒有在 Microsoft 官方頁面上確認過**
> （開發環境連不到），請你自己開 [Azure Speech 定價頁](https://azure.microsoft.com/en-us/pricing/details/speech/)
> 核對，並確認免費層 (F0) 的額度。

### 怎麼拿 Gemini 金鑰

1. 到 <https://aistudio.google.com/apikey> 建立 API key
2. 把它填進專案根目錄的 `.env`：

   ```
   GEMINI_API_KEY=AIza...
   ```

`@google/genai` 的 SDK 預設就是讀 `GEMINI_API_KEY` 這個環境變數名稱，不要改名。

**Gemini 現在是選填的。** 接上 Azure 之後它不再負責評分，只負責把 Azure 的分數
寫成中文教練建議 —— 而且吃的是一小段 JSON 而不是音訊，成本比原本低很多。
沒設定的話講評會改用本地摘要，Azure 的分數照樣看得到。

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

`.env` 已列在 `.gitignore`，不會被 commit。前端程式碼裡沒有任何金鑰 ——
Azure 與 Gemini 的呼叫都在後端，錄音是 POST 到自己的伺服器再轉送出去。

### 從設定頁填金鑰 —— 安全邊界

設定頁可以直接填金鑰，伺服器會寫進 `.env`（檔案權限設成 `600`），並立即套用，
不用重啟。前端永遠拿不到完整金鑰 —— `GET /api/settings` 只回「是否已設定」與末四碼。

**`/api/settings` 只接受來自 loopback（`127.0.0.1` / `::1`）的請求**，其他來源一律 403。
這是因為「讓網頁寫入伺服器的 .env」在公開網路上非常危險。

> ⚠️ **如果之後要把這個 App 部署到雲端，必須先移除 `/api/settings` 這兩個端點，
> 或加上真正的身分驗證。** loopback 檢查擋得住區網，但擋不住反向代理背後的請求
> （那時所有請求看起來都來自本機）。

不想用設定頁的話，直接手動編輯 `.env` 也完全可以。

---

## 錯誤處理

所有失敗情境都會在前端顯示繁體中文的說明，講清楚該做什麼，不會只丟 error code。

**Azure（發音評估）**

| 情境 | HTTP | 說明 |
|---|---|---|
| 沒設定 Azure 金鑰／區域 | 500 | 啟動時 console 也會警告 |
| 金鑰或區域錯誤 | 401 | 明確提示區域要跟建立資源時一致 |
| 額度用盡／無權限 | 403 | |
| 請求太頻繁 | 429 | 免費層併發數很低 |
| 聽不到清楚語音 | 422 | 提示使用者大聲一點重錄 |
| 連不到 Azure | 502 | |
| 逾時（30 秒） | 504 | |

**Gemini（中文講評）**

講評失敗**不會**讓整個請求失敗 —— Azure 的分數照樣回給使用者，講評改用本地摘要。
只有在完全沒設定 Azure、由 Gemini 負責評分時，下面這些才會變成請求層級的錯誤：

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
├── package.json
├── content/              # 靜態學習內容（開發時寫好，非執行期生成）
│   ├── sentences.json    # 27 句跟讀練習句
│   ├── vocabulary.json   # 40 張單字卡
│   ├── listening.json    # 10 組聽力題（題目與選項為英文，解析為中文）
│   └── translation.json  # 20 題中翻英（填空 + 整句）
├── server/
│   ├── index.js          # Express、路由、本地摘要 fallback
│   ├── settings.js       # 讀寫 .env 的金鑰設定（僅接受 localhost 請求）
│   ├── azure-pronunciation.js  # Azure Speech 發音評估 + 錯誤分類
│   └── gemini.js         # Gemini：中文講評（主要）、主觀評分（無 Azure 時的退路）
└── public/
    ├── index.html        # 外殼
    ├── style.css
    ├── app.js            # 模式切換
    ├── lib/
    │   ├── dom.js        # 極簡元素建構工具
    │   ├── tts.js        # speechSynthesis（處理 getVoices 非同步的雷）
    │   ├── recorder.js   # 錄音、格式挑選、麥克風錯誤訊息
    │   ├── wav-encoder.js  # 錄音 → 16 kHz 單聲道 WAV
    │   ├── storage.js    # localStorage：SRS 排程、練習紀錄
    │   └── settings.js   # localStorage：偏好設定與內容篩選
    └── modes/
        ├── vocabulary.js
        ├── listening.js
        ├── translation.js
        ├── shadowing.js
        ├── settings.js
        └── assessment-view.js  # 發音評估結果的呈現
```

模式是動態 `import()` 進來的，切到哪個才載入哪個。

### 三種模式

**單字卡** 用 Leitner 盒子制做間隔重複：答對往上一盒、間隔拉長（1 → 3 → 7 → 21 天），
答錯直接回第 1 盒。排程存在 `localStorage`。用盒子制而不是 SM-2，是因為行為好預測、
出問題也容易看懂。

**聽力** 用瀏覽器內建的 `speechSynthesis` 朗讀短文，作答後才顯示正解與解析；
聽不出來也可以先看原文。

**中翻英** 有兩種題型。**填空**只考一個關鍵字，答錯就是答錯。**整句翻譯**沒辦法精確
自動批改（同一個意思有很多種講法），所以分三級：完全相符、關鍵字都有（算通過，
但列出參考答案）、差太多。作答後會逐字比對，紅色是參考答案有但你沒寫到的字，
灰底是你多寫的 —— 但會明講「意思對就好，用字不必完全一樣」。

**跟讀** 是原本的口說練習。發音評分現在是次要按鈕（「🎯 檢查我的發音（選用）」），
沒設定金鑰也能正常練 —— 聽示範、錄音、自己比對本來就有用。

**設定** 可以直接在網頁上填 API 金鑰（寫進伺服器的 `.env`，見下方安全說明）、
篩選練習的情境與難度、選示範發音的聲音與語速、清除學習資料。

### API

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/health` | 回 `{ ok, azureConfigured, geminiConfigured }` |
| GET | `/api/content/:name` | `sentences` / `vocabulary` / `listening` / `translation` |
| GET | `/api/settings` | 金鑰設定狀態（**遮蔽過**，只回是否已設定與末四碼）|
| POST | `/api/settings` | 更新金鑰，寫進 `.env` |
| GET | `/api/sentences` | 舊路徑，307 轉址到 `/api/content/sentences` |
| POST | `/api/pronunciation-feedback` | multipart：`audio`（WAV 檔）+ `sentence`（目標句） |

**有設定 Azure 時**的回傳：

```json
{
  "provider": "azure",
  "referenceText": "目標句",
  "recognizedText": "Azure 聽到的內容",
  "scores": {
    "pronunciation": 84.5, "accuracy": 82, "fluency": 91,
    "completeness": 86, "prosody": 58
  },
  "words": [
    { "word": "thoroughly", "accuracy": 55, "errorType": "Mispronunciation",
      "phonemes": [{ "phoneme": "θ", "accuracy": 31 }] }
  ],
  "feedback_zh": "• 條列講評…",
  "narrationSource": "gemini"
}
```

`errorType` 可能是 `None` / `Mispronunciation` / `Omission`（漏唸）/ `Insertion`（多唸）/
`UnexpectedBreak` / `MissingBreak` / `Monotone`。

前端把每個字依 `accuracy` 分三級標色（≥80 綠、60–79 黃、<60 紅），`Omission` 加刪除線，
低於 70 分的音素以 IPA chip 列出。

**沒設定 Azure 時**退回 Gemini 的主觀評分，回傳 `{ provider: "gemini", transcript,
score, problem_words, feedback_zh }`，前端改用 LCS 逐字比對標色，並在 UI 上註明
這是 AI 主觀評估、不是標準化測驗分數。

### 為什麼用 Azure 評分、Gemini 講評

LLM 判斷發音準不準本質上是主觀的 —— 同一段錄音送兩次分數可能不一樣。
Azure 的發音評估是專門做這件事的模型，給的是逐音素的客觀分數。

但 Azure 只給數字和 `ErrorType`，不會說「th 要把舌尖輕觸上齒」。
所以分工是：**Azure 負責聽，Gemini 負責講**。

Gemini 這時候吃的是一小段 JSON 而不是音訊（音訊計費是 32 tokens/秒），
成本比原本的「把錄音送給 Gemini」低很多，也不必把使用者的錄音再送一份給第二個服務。

### 為什麼錄音要轉成 16 kHz 單聲道 WAV

原本的理由是 Gemini：它的 audio 文件列的支援格式是 `wav / mp3 / aiff / aac / ogg / flac`，
Firebase AI Logic 的輸入需求頁卻多列了 `webm` —— 兩份官方文件不一致，
而 `audio/webm` 正好是瀏覽器 `MediaRecorder` 的預設輸出，落在有爭議的那一邊。
（後來也確認 `@google/genai` 的 `AudioContentMimeType` 型別裡完全沒有 `audio/webm`。）

所以一律在瀏覽器端轉成 WAV 再送（`public/lib/wav-encoder.js`）：

`MediaRecorder` → `blob.arrayBuffer()` → `decodeAudioData()` → `OfflineAudioContext`
重取樣成單聲道 16 kHz → 自寫的 44-byte RIFF header 編成 16-bit PCM WAV。

**接上 Azure 之後這個決定剛好有第二個好處。** Azure Speech SDK 的預設輸入格式定義寫的是：

> the default audio stream format (**16KHz 16bit mono PCM**)

正好就是 `lib/wav-encoder.js` 產出的格式，音訊管線一個 byte 都不用改。

其他好處：不需要 ffmpeg 之類的外部依賴；16 kHz 單聲道對語音辨識綽綽有餘
（每秒約 32 KB）；而且 Safari 的 `MediaRecorder` 吐的是 mp4/aac 而非 webm，
走 `decodeAudioData` 這條路兩邊格式就統一了。

### 為什麼不用 Web Speech API 做辨識

`SpeechRecognition` 只接受**即時**麥克風輸入，介面上沒有任何方式可以餵進錄好的 File / Blob，
所以「錄完再拿去辨識」這條路不存在。而且 Chrome 的實作是送到 Google 伺服器辨識、
MDN 標記為 "Limited availability"、Firefox 支援有問題。

改用的做法（階段 4）：讓 Gemini 在**同一次呼叫**裡一起回傳 transcript 和分數，
一次 API 呼叫解決，跨瀏覽器一致，不需要第二套依賴。

---

## 已驗證與未驗證

**已驗證（在開發環境實際跑過）：**

- 錄音 → WAV 轉換：真實瀏覽器（Chromium 假麥克風）跑完整流程，
  webm/opus → 16 kHz 單聲道 WAV，`<audio>` 能正常解碼播放；
  WAV header 逐欄位比對（RIFF/fmt/data、byteRate、bitsPerSample、clamp 邊界）
- 你在 Firefox 上實測過真實麥克風錄音與回放
- Azure 結果解析：用真實的 Azure JSON 格式（含 `NBest[0]` 結構）
  跑真正的 `PronunciationAssessmentResult` 類別，五個分數與逐字／逐音素明細都正確取出
- Azure SDK 的參數形狀：`fromWavFileInput(Buffer)` 在 Node 可用、
  `fromAuthorizationToken` 存在、`PronunciationAssessmentConfig` 產生的 JSON 正確
- 前端渲染：用模擬的 Azure 回應跑完整流程，分數、標色、音素 chip、
  Gemini 退路分支都正確，無 console 錯誤
- Gemini 的錯誤分類：用無效金鑰實測，請求確實打到 `generativelanguage.googleapis.com`
- 各種錯誤情境的前端提示（麥克風權限、裝置、檔案過大等）
- 三種模式在真實瀏覽器跑過完整流程：單字卡翻面／作答／SRS 盒號遞增與寫入
  `localStorage`、聽力作答與計分與解析、跟讀錄音與 WAV 轉換、模式切換與記憶，
  全程無 console 錯誤
- `content/` 三份 JSON 的結構檢查（id 不重複、選項數、正解索引範圍、必填欄位）

**未驗證（需要你在 WSL 上用真實金鑰確認）：**

- **Azure 的實際呼叫** —— 開發環境的 egress proxy 擋掉了
  `*.stt.speech.microsoft.com` 與 `*.api.cognitive.microsoft.com`（CONNECT 回 403），
  所以連認證失敗的路徑都測不到。程式邏輯有寫，但沒有真的跟 Azure 交握過。
- **Gemini 的成功路徑** —— 開發環境沒有可用金鑰
- 講評的實際品質（prompt 可能需要依真實輸出調整）

---

## 已知限制

- **必須用 `localhost` 開啟。** `getUserMedia` 需要 secure context；`localhost` 算 secure，
  但用區網 IP（例如 `http://192.168.1.5:3000`）開啟時瀏覽器會直接擋掉麥克風。
  要在手機或其他機器上測試，得先架 HTTPS。
- **Azure 的語調（prosody）評估目前只支援 en-US。** 其他 locale 拿不到 prosody 分數。
- `speechSynthesis` 的語音品質取決於作業系統安裝的語音包，各平台聽起來會不一樣。
- 目前沒有練習紀錄，重新整理頁面後結果就消失。
- 單次錄音上限 60 秒，上傳上限 8 MB。

---

## 在 WSL 上開發

建議把專案放在 **WSL 自己的檔案系統**（例如 `~/english_speaking`），
不要放在 `/mnt/c/...` —— `node_modules` 在 Windows 掛載點上讀寫會慢很多。

WSL2 有 localhost 轉發，所以在 WSL 裡 `npm start`、用 Windows 的瀏覽器開
`http://localhost:3000`，瀏覽器會認定這是 localhost，secure context 成立、麥克風可以用。
這點對這個專案很關鍵，因為改用區網 IP 開就會被瀏覽器擋掉麥克風。

---

## 接下來

- **情境對話**（獨立功能，還沒做）—— 多輪對話狀態，是四個模式裡最複雜的
- 練習紀錄的檢視畫面（`storage.js` 已經在記錄跟讀的每次嘗試，但還沒有 UI）
- 例句／單字依情境與難度篩選（資料已經有 `category` 與 `difficulty` 欄位）
- 錄音波形視覺化（`AnalyserNode`）
