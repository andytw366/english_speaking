# 交接筆記

給接手的新 session 用。專案脈絡、已完成的部分、待辦，以及過程中踩過而**不要重踩**的雷。

---

## 現況

分支 `claude/english-speaking-practice-app-vukgm7`，已與 GitHub 同步（截至 `58affe5`）。

本機執行的英語學習網頁 App，六種模式。**沒有 build step**，純 HTML + CSS + ES modules + Express。

```bash
npm install
cp .env.example .env      # 金鑰選填，不填也能用四種模式
npm start                 # http://localhost:3000
```

| 模式 | 內容 | 狀態 |
|---|---|---|
| 🗂️ 單字卡 | 10,040 字（精選 40 + 10 個詞頻級距各 1,000） | 完成 |
| 🎧 聽力 | 81 組 / 226 題 | 完成 |
| ✍️ 中翻英 | 279 題（填空 161 / 整句 118） | 完成 |
| 💬 情境對話 | 61 段 / 185 句台詞 | 完成 |
| 🗣️ 跟讀 | 27 句 + 選用 AI 發音評分 | 完成 |
| ⚙️ 設定 | 金鑰、篩選、語音、資料管理 | 完成 |

---

## 待辦

### 1. 手機版 —— 等使用者決定路線（最優先，卡在決策）

使用者要做手機版，但**還沒決定走哪條路**。兩個選項已經說明過，等他回覆：

- **PWA** —— 加 manifest + service worker，約半天。不能上架，需要 HTTPS 才能用麥克風。
- **Capacitor** —— 包成原生 App 可上架，麥克風是原生權限不需要 HTTPS。iOS 必須有 Mac + Xcode。

**建議先做 PWA**：介面在手機上順不順這件事兩條路都要面對，PWA 最快能試出來，
之後要再包 Capacitor 是加一層殼，工作不會浪費。

**兩條路都要先解決的問題：金鑰放哪裡。**
現在金鑰在伺服器的 `.env`，手機版沒有那台伺服器。兩個選擇：
(a) 架一個後端（Render / Railway），(b) 使用者自己填金鑰存在裝置上。
自用 App 建議 (b)。**絕對不能把開發者自己的金鑰打包進 App** —— 會被挖出來盜用。

另外不管走哪條路都要做的：**手機介面調整**（觸控目標放大、單字卡適合單手操作、
錄音按鈕移到拇指區）。

### 2. 沒做完的小功能

- 練習紀錄的檢視畫面 —— `lib/storage.js` 的 `addAttempt()` 已經在記錄跟讀的每次嘗試，但沒有 UI
- 情境對話的進度存進 `localStorage`（目前重新整理就重來）
- 錄音波形視覺化（`AnalyserNode`）

### 3. Azure 尚未端對端驗證

`server/azure-pronunciation.js` 的**實際呼叫從來沒成功跑過**。
開發容器的 egress policy 擋掉 `*.stt.speech.microsoft.com` 與
`*.api.cognitive.microsoft.com`（CONNECT 回 403），連認證失敗的路徑都測不到。

已驗證的是：SDK 參數形狀（對照型別定義）、結果解析（用真實 Azure JSON 的
`NBest[0]` 結構跑真正的 `PronunciationAssessmentResult`）、前端渲染（mock 回應）。
**使用者說在他本機測過可以動**，但這裡沒有證據，接手時不要假設它一定沒問題。

---

## 不要重踩的雷

以下每一項都是實際踩到並修好的，改動相關程式碼時請留意。

### 音訊

- **錄音一律轉成 16 kHz 單聲道 WAV 再送**（`public/lib/wav-encoder.js`）。
  原因：Gemini 的兩份官方文件對 `audio/webm` 的支援說法不一致，而那是 `MediaRecorder`
  的預設輸出。後來確認 `@google/genai` 的 `AudioContentMimeType` 型別裡**完全沒有** webm。
  附帶好處：Azure Speech SDK 的預設輸入格式正好也是 16 kHz 16-bit 單聲道 PCM。
- `MediaRecorder` **不要寫死 webm**，Safari 不支援（會吐 mp4/aac）。用 `isTypeSupported()` 挑。
- `getUserMedia` 需要 secure context。`localhost` 可以，**區網 IP 不行**。

### JavaScript 陷阱

- **`??` 不會對空字串 fallback。** 曾經寫成
  `(wantVoice && find(...)) ?? fallback`，而 `wantVoice` 預設是空字串，
  `&&` 短路回傳 `''`，`??` 不接手，結果 `voice` 變成字串而不是 voice 物件，
  **所有模式都發不出聲音**。已改成三元運算子。
- **`h()` 的 children 要深層攤平。** `map()` 回傳巢狀陣列時只攤一層，
  內層會被當成文字印出 `[object HTMLSpanElement]`。已改用 `flat(Infinity)`。
- **`e.currentTarget` 在非同步 callback 裡是 `null`。** 要在同步階段先把元素抓下來。
- **`speechSynthesis.getVoices()` 首次常回空陣列。** 已在 `lib/tts.js` 用
  `voiceschanged` + polling 處理。
- **`window.speechSynthesis` 在 Chromium 是唯讀屬性**，寫測試 stub 時直接指派會被
  無聲忽略，要用 `Object.defineProperty`。

### 資料與 API

- **SRS 的鍵要有牌組前綴。** 不同牌組的 id 會重複（精選第 1 張與第一級距第 1 張
  都是 id 1），沒前綴的話兩張不同的卡會共用複習進度。見 `lib/storage.js` 的 `srsKeyOf()`。
- **Gemini 對無效金鑰回的是 HTTP 400，不是 401/403**，而且 SDK 訊息裡看不到
  `API_KEY_INVALID`。所以 400 的錯誤訊息要同時提示金鑰與音檔兩種可能。
- **`/api/settings` 只接受 loopback 請求。** 它會寫入伺服器的 `.env`。
  **部署到雲端前必須移除這兩個端點或加真正的認證** —— loopback 檢查擋得住區網，
  但擋不住反向代理背後的請求。

### 內容

- **解析不能只是把英文原句抄一遍加中文句號。** 這是我在這個專案裡反覆犯的錯，
  三個聽力批次分別被驗證擋下 12、0、5 筆，全是同一個問題。
  `scripts/generate-content.mjs` 的驗證會擋，**新增內容一定要跑過那套驗證**。
- ECDICT 的原始資料很髒：釋義是簡體、音標混用非 IPA 字元
  （`ә` 是西里爾字母、`^` 其實是 `ɡ`、`\` 是 `ɜ`）。清理邏輯都在
  `scripts/build-vocabulary.mjs`，改那個檔前先讀註解。

---

## 開發環境限制

這個遠端容器的 egress 是**逐主機允許清單**，不是全開：

| 可連 | 不可連 |
|---|---|
| `generativelanguage.googleapis.com` | `*.stt.speech.microsoft.com` |
| `github.com` / `raw.githubusercontent.com` | `*.api.cognitive.microsoft.com` |
| `registry.npmjs.org` | `learn.microsoft.com` / `azure.microsoft.com` |
| `login.microsoftonline.com` | `example.com` |

被擋時 `curl -sS "$HTTPS_PROXY/__agentproxy/status"` 會列出 `recentRelayFailures`。
**不要繞過它**，環境的說明明確要求回報而不是繞道。

其他：
- 背景執行伺服器要用 harness 的 background 機制，用 `&` 會隨 shell 結束而死
- `pkill -f "node server/index.js"` 會連自己的 shell 一起殺掉（exit 144），
  改用 `ps` 找 PID 再 kill
- 容器在這次工作中重啟過兩次，**分階段 commit**，不要累積一大批未提交的成果

---

## 怎麼驗證改動

```bash
# 內容驗證（三份題庫都要通過）
node --input-type=module -e "
import fs from 'node:fs';
const { TYPES } = await import('./scripts/generate-content.mjs');
for (const [t,spec] of Object.entries(TYPES)) {
  const items=JSON.parse(fs.readFileSync('content/'+spec.file,'utf8'));
  const bad=items.filter(x=>spec.validate(x));
  console.log(t, items.length, bad.length ? '❌'+bad.length : '✅');
}"
```

瀏覽器測試用 Playwright（`/opt/node22/lib/node_modules/playwright`），
Chromium 已預裝。錄音測試加 `--use-fake-device-for-media-stream`，
TTS 測試要 stub 掉 `speechSynthesis`（見上面的唯讀屬性雷）。

---

## 擴充題庫

```bash
npm run build:vocabulary -- --total 3000 --band 500   # 重建單字庫
node scripts/generate-content.mjs listening --count 20 --dry-run
```

現有題庫是手寫的。生成腳本的價值主要在**那套驗證**，不管內容是誰寫的都得過同一關。
