# 英語學習 App（speaking-coach）

本機執行的網頁 App，六種練習模式。**沒有 build step** —— 純 HTML + CSS + ES modules + Express。

| 模式 | 內容 |
|---|---|
| 🗂️ 單字卡 | 10,040 字，**自己選難度**（國中 → 高中 → 四級 → 六級 → 檢定 → GRE 六級）＋**每日目標**＋**中英雙向選擇題**，Leitner 盒子制間隔重複 |
| 🎧 聽力 | 81 組 / 226 題 |
| ✍️ 中翻英 | 279 題（填空 161 / 整句 118） |
| 💬 情境對話 | 61 段 / 427 句台詞，角色扮演 |
| 🗣️ 跟讀 | 2,041 句，錄音後拿到**逐音素**的發音評估 |
| ⚙️ 設定 | 金鑰、單字題型與每日單字數、練習範圍、語音、學習資料（含**備份與還原**） |

> **這個 repo 曾經有兩個平行發展的 App**：一邊把「口說」一種模式做深（間隔重複、
> 音素級回饋、2,041 句句庫、CI、Docker 部署），一邊把「六種模式」做廣
> （單字、聽力、中翻英、情境對話、跟讀，加上 Azure 發音評估）。
> 兩邊都占用 repo 根目錄的同名檔案，所以做了一次整合：**以六模式為外殼，
> 口說那一整套收進「跟讀」模式**，發音評分改用 Azure。功能沒有捨棄任何一邊的。

---

## 需求

| 項目 | 需求 |
|---|---|
| Node.js | **>= 20.0.0**（`@google/genai` 的 `engines` 要求）。開發環境用 v22 |
| 瀏覽器 | Chrome / Edge 建議。Safari 可用（錄音格式會是 mp4/aac，程式會自動轉成 WAV） |
| 網址 | 直接 `npm start` 時**必須用 `http://localhost:3000`**，原因見「已知限制」。要在手機上用請看「用 Docker 跑在自己的機器上」 |

## 安裝與啟動

```bash
npm install
cp .env.example .env      # 兩組金鑰都是選填的，不填也啟動得起來
npm start                 # http://localhost:3000
```

**不填金鑰的話，六種模式裡有五種完全可用** —— 只有「跟讀」的發音評分需要 API。
單純想練發音的話，聽示範 → 錄音 → 自己比對就很有幫助了。

---

## 兩組金鑰，各自負責不同的事

```
錄音 ──► Azure Speech ──► 客觀分數（逐字、逐音素）──► Gemini ──► 中文教練建議
                │                                        │
         沒設定就退回                              沒設定就用本地摘要
         Gemini 給主觀分數                        （分數照樣看得到）
```

**為什麼這樣分工：** 讓語言模型「聽」音訊給發音分數，本質上是要它做聲學比對 ——
它會給出看起來合理但不可靠的數字（詳見下方「無人聲偵測」，同一段靜音在五個 model
裡有三個給 95 分以上）。Azure 的發音評估是專門做這件事的服務，回的是
準確度／流暢度／完整度／語調四個面向加上**每個音素的分數**。

Gemini 則負責它真正擅長的事：把那堆數字寫成「th 要把舌尖輕觸上齒」這種可執行的建議。
而且它吃的是一小段 JSON 而不是音訊，成本比原本低很多。

### 怎麼拿 Azure Speech 金鑰

1. 到 [Azure 入口網站](https://portal.azure.com) 建立一個「語音服務 (Speech service)」資源
2. 在「金鑰與端點」頁面複製 **KEY 1** 與**位置/區域**
3. 填進 `.env`：

   ```
   AZURE_SPEECH_KEY=你的金鑰
   AZURE_SPEECH_REGION=eastasia
   ```

`AZURE_SPEECH_REGION` 必須跟建立資源時選的區域一致（`eastasia`、`japaneast`、`westus`…），
填錯會得到認證失敗。

> **計費（請自行確認最新數字）：** 查到的資料是即時語音轉文字 $1/小時、
> 發音評估再加 $0.30/小時，合計約 $1.30/小時 —— 一句 5 秒的練習約 $0.0018。
> **這個數字沒有在 Microsoft 官方頁面上確認過**（開發環境的 egress 連不到），
> 請自己開 [Azure Speech 定價頁](https://azure.microsoft.com/en-us/pricing/details/speech/)
> 核對，並確認免費層 (F0) 的額度。

### 怎麼拿 Gemini 金鑰

到 <https://aistudio.google.com/apikey> 建立 API key，填進 `.env` 的 `GEMINI_API_KEY`。
`@google/genai` 預設就是讀這個環境變數名稱，不要改名。

> **計費提醒：** Google AI Pro／Ultra 訂閱**不包含** Gemini API 額度 ——
> 訂閱福利只在 AI Studio 網頁介面內有效，用 API key 呼叫是分開計費的。
> 那個「每月 $10 額度」來自 **Google Developer Program 的 Premium 方案**。
> **不過 Gemini API 本身有免費層，這個專案用免費層跑就夠了。**

講評用哪個 model 可以在「設定」頁選，清單寫死在後端（`server/gemini.js` 的 `MODELS`），
送上來的值也會再驗一次 —— **選單是 UI，不是權限**。少了這道檢查就等於讓瀏覽器
把任意字串塞進 API 呼叫。

| model | 備註 |
|---|---|
| `gemini-3.7-flash` | 最新 |
| `gemini-3.6-flash` | **預設**，實測穩定 |
| `gemini-3.5-flash` | 明顯較慢（實測約 13 秒） |
| `gemini-3.5-flash-lite` | 快 |
| `gemini-3.1-flash-lite` | 最快，品質較陽春 |

清單是實測出來的，不是照 `ListModels` 抄的 —— `ListModels` 只說某個 model 支援
`generateContent`，不會告訴你它吃不吃得下音訊、structured output 回不回得了 JSON。
被排除的：Pro 系列（免費層直接 429）、`gemini-2.5-flash`（`output_text` 不是 JSON）、
`gemini-2.5-flash-lite`（404「no longer available to new users」）。

### 覺得慢？中文講評可以整段關掉

跟讀送出一次錄音要等兩段：**Azure 給分數**（快）、**Gemini 把分數寫成中文建議**
（慢，看 model 幾秒到十幾秒）。想連著練十句的時候，後面那段就是純粹的等待 ——
而分數、四個面向、逐字逐音素的標色在沒有講評的情況下已經全都看得到了。

所以「設定 → 跟讀的中文講評」可以關掉它。關掉之後：

| | 開著 | 關掉 |
|---|---|---|
| Azure 的分數與逐音素標色 | 有 | **一樣有** |
| 中文講評 | Gemini 寫的具體建議 | 後端的本地摘要（`server/narration.js`）：最弱的面向 + 唸不好的字與音素 |
| 送出後要等 | Azure + Gemini | 只等 Azure |
| Gemini 配額 | 每句一次呼叫 | **完全不呼叫** |

設定存在瀏覽器的 localStorage（`geminiNarration`），關掉時前端才會多送一個
`narrate=off`；後端沒收到這個欄位就當成「要」，所以舊前端的行為不變。

兩個相關的細節：

- **講評用的超時比評分短**（`NARRATION_TIMEOUT_MS` 20 秒，評分那條路是 60 秒）。
  講評失敗會自動退回本地摘要、分數照樣回得來，所以寧可早一點放棄，
  也不要讓人對著轉圈圈等一分鐘。
- **講評成功時，畫面會寫出這次等了幾秒**（`narrationMs`）。「值不值得等」
  要看得到數字才判斷得出來，不然只會累積成「Gemini 很慢」這種模糊印象。

> **沒設定 Azure 的話這個開關省不到時間** —— 那條路上分數本身就是 Gemini 給的。
> 設定頁會直接把這件事寫在開關下面（它讀 `/api/health` 的 `azureConfigured`），
> 講評畫面也會標 `narrationReason: "gemini_scores"`。

### `.env` 的位置

`.env` 放在**專案根目錄**（不是 `server/` 底下）。`dotenv` 預設從 process 的 cwd 找，
所以 `server/index.js` 明確指定了根目錄的路徑，從任何 cwd 執行都讀得到。

`.env` 已列在 `.gitignore`。前端程式碼裡沒有任何金鑰 —— Azure 與 Gemini 的呼叫都在後端，
錄音是 POST 到自己的伺服器再轉送出去。

### 從設定頁填金鑰 —— 安全邊界

設定頁可以直接填金鑰，伺服器會寫進 `.env`（權限 `600`）並立即套用，不用重啟。
前端永遠拿不到完整金鑰：`GET /api/settings` 只回「是否已設定」與末四碼。

**`/api/settings` 只接受來自 loopback（`127.0.0.1` / `::1`）的請求**，其他一律 403。

> ⚠️ 這一關在**反向代理後面的行為要看代理怎麼接**：
> - 用本專案的 Docker 部署（Caddy 在另一個容器，走 `app:3000`）→ 來源是容器 IP，
>   **會被正確擋掉**，那種情況金鑰請直接寫在 `.env` 裡。
> - 如果代理跟 App 跑在同一台、而且是 `reverse_proxy localhost:3000` →
>   來源會變成 `127.0.0.1`，**檢查就失效了**，任何連得到代理的人都能寫你的 `.env`。
>   那種部署一定要先移除這兩個端點或加上真正的身分驗證。

---

## 六種模式

### 🗂️ 單字卡

10,040 字。用 **Leitner 盒子制**（1～5 盒，答對往上一盒、間隔拉長；答錯回第 1 盒），
而不是 SM-2 —— 行為好預測、出問題也容易看懂。

**自己選難度。** 同一批字有兩種切法，選單以難度為主：

| 切法 | 牌組 | 什麼時候用 |
|---|---|---|
| **依難度**（主要） | 6 級：入門｜國中 1,430、基礎｜高中 1,939、進階｜四級 1,946、高階｜六級 1,277、檢定｜TOEFL/IELTS 1,293、艱深｜GRE 與冷門字 2,115 | 平常練。選一級之後就只從那一級抽 |
| 依詞頻級距 | 10 組，每組 1,000 字（第 1–1,000 常用…） | 想照詞頻順序練。預設收起來 |
| 精選 | 40 字，手寫，含例句、中譯與發音提示 | 想要有例句的時候 |

分級用的是 **ECDICT 的考試標籤**（`zk` 國中、`gk` 高中、`cet4`、`cet6`、`toefl`、
`ielts`、`gre`、`ky` 考研），規則在 `scripts/vocab-levels.js`：

- **取最簡單的那一個標籤** —— 一個字同時掛 `zk` 與 `gre` 時，它是國中就學過的字，
  不是 GRE 單字。
- **沒有任何標籤的字**（10,000 個裡有 2,272 個）用詞頻與 Collins 星等補位：
  5 星或前 2,000 名 → 基礎，3 星或前 5,000 名 → 進階，其餘 → 艱深。
- **為什麼不用現成的 `difficulty` 欄位**：那一欄是從詞頻機械換算的
  （前 2,000 = easy、2,001–5,000 = medium、其餘 hard），跟「第幾個 1,000 常用」
  是同一件事的兩種說法 —— 拿它當難度選單等於還是在選級距。
- 考研（60 個字）與 GRE（312 個）單獨成級太小，所以併進「艱深」。
  `vocabulary.test.js` 有一條釘住「每一級都在 500～3,500 字之間」，
  改規則時會擋下又切出一個練不起來的級。

**題型可以複選**（設定裡的「單字卡的題型」）：

| 題型 | 樣子 |
|---|---|
| 看中文選英文 | 題目「顯示」→ 四個英文選項 |
| 看英文選中文 | 題目「show」＋音標＋發音鍵 → 四個中文選項 |
| 翻卡 | 原本的樣子：看字 → 顯示答案 → 自己按「記得 / 還不熟」 |

勾幾種就混哪幾種，一張卡一抽。預設是兩種選擇題。

> **為什麼是選擇題而不是打字。** 輸入式最大的問題不是程式，是資料 ——
> 10,000 個字裡有 2,928 個（29%）跟別的字共用同一個中文義項
> （「完全地」有 7 個字：absolutely / completely / totally / perfectly…）。
> 看中文打英文的話，使用者打了一個「也對」的答案卻被判錯，只能靠一顆
> 「其實我對了」的按鈕擦屁股；英→中更慘，中文的同義說法太多，幾乎無法批改。
>
> 選擇題把這件事變成**出題規則**：干擾項只從同一級裡挑**義項完全不重疊**
> 的字（詞性也盡量一致），所以一題不會有兩個對的答案。規則在 `lib/quiz.js`，
> `quiz.test.js` 會拿真的字庫掃過六個分級各 40 個字、兩個方向，
> 逐一確認沒有任何干擾項跟答案共用義項。
>
> 順帶拿到三件事：批改 100% 準確、手機上一按就好（不用切輸入法），
> 以及**間隔重複的訊號變客觀** —— 進不進下一個盒子不再是使用者自己說了算。
>
> 湊不到足夠的干擾項時（例如精選那 40 張裡同義的太多）會**退回翻卡**，
> 不會出一題只有兩個選項的題目。

**每天練幾個字**（設定裡的「單字卡每天練幾個字」，預設 20）：選好難度之後，
單字卡每天就從那一級抽這麼多個字。順序還是 `buildQueue()` 決定的
—— 到期要複習的優先，再補沒學過的。

> **為什麼是「一天」而不是「一輪」。** 舊的設定叫「一輪最多幾張」，
> 而「一輪」關掉重開就再來一輪 —— 那個數字其實沒有限制任何東西，也沒辦法
> 回答「我今天練了嗎」。現在算的是日期：`lib/storage.js` 存一張
> 「哪一天練了幾張」的計數表（`{ '2026-09-05': 23, … }`，只留最近 400 天），
> 所以關掉重開、中途換一級，今天的數字都還在。
>
> **為什麼不從 `srs` 算**：srs 每張卡只留最後一次的狀態（box / due / seen），
> 答過就被下一次蓋掉 —— 算不出「今天練了幾張」，更算不出連續天數。

練完當天的份會顯示「今天的 20 個字練完了」與連續天數，但**不擋著不讓練** ——
有一顆「再多練 10 個」。目標是拿來知道自己完成了，不是拿來鎖門的。
設 0 表示不設目標，那一級的字會一次全部排進來。

「今天練了幾個 / 目標幾個」加連續天數的那張卡在 `lib/today-card.js`，**跟讀共用同一張**
（連續天數的算法也是同一份 `streakFromDays()`）—— 各寫一份的話，改了其中一邊的文案，
另一邊就會慢慢變成另一種語氣，而跨月、日光節約這些邊界也會各錯各的。

> 鼓勵的話刻意不寫「你今天還沒練，連續天數要斷了」這種句子 —— 用罰的推人回來，
> 短期有效，長期只會讓人不想打開。`vocabulary.test.js` 有一條掃過所有文案，
> 出現「斷／沒了／快要／失去」就紅。

**各級進度**怎麼算出來的：卡片 id 就是全域詞頻排名，所以 `tier-map.json` 用一個
長度 10,000 的陣列（20 KB）記「id 是第幾級」。選難度的畫面因此只要這個小檔案
加 `localStorage` 就畫得出六級的進度條 —— **不必把六個分級檔（3 MB）全部載下來**。

熟練度到 80%（或沒學過的剩不到 10%）會出現「進到下一級」的提示。**不自動跳級** ——
難度是使用者自己選的。

> **SRS 的鍵用牌組的 `keyspace`，不是牌組 id。** 難度分級與詞頻級距是**同一批字的
> 兩種切法**、id 也是同一個，所以兩者共用 `ecdict:` 這個命名空間 ——
> 在「第 1–1,000 常用」記熟的字換去「入門｜國中」練，不會變回「沒學過」。
> 精選的 id 從 1 起算、會跟 ECDICT 的字撞（精選第 1 張是 thorough、ECDICT 第 1 個是 say），
> 所以它自己一個 `curated:`。
>
> 舊版的鍵是 `band-3:2001` 這種形式，`lib/storage.js` 的 `migrateSrs()` 會把它搬成
> `ecdict:2001`。**搬家不看版本號、每次載入都跑一遍**（只在真的有東西要搬時才寫回去）——
> 用版本號當關卡的話，「版本已經是 2 但還有舊鍵留著」這個狀態就永遠搬不動，
> 而症狀是進度看起來歸零、沒有任何錯誤訊息。

### 備份與還原（設定 → 學習資料）

「下載備份」會存出一個 JSON，裡面是複習進度（`srs`）、每天練了幾張（`vocabDays`）、
跟讀紀錄（`history`）與偏好設定（`settings`）。**不含金鑰** —— 那些在伺服器的 `.env`。

**為什麼這件事排在所有新功能前面**：這些東西**重建不出來**。句庫可以重跑腳本，
「你哪一天練了什麼、哪個字進到第幾盒、連續幾天」不行，而它們全都只存在
一個瀏覽器的 `localStorage` 裡。

還原的規則：

- **是覆蓋不是合併。** 合併兩份複習進度得決定「同一個字兩邊都有時聽誰的」，
  而任何一種選法都會在某些情況下把人往回推。覆蓋至少是可預期的。
- **覆蓋前會先講清楚「用什麼覆蓋」**（那份備份有幾個字、幾天、幾筆跟讀紀錄）。
  只問「確定嗎」而不講內容的確認，等於沒有確認。
- **壞掉的檔案一律擋下來、不動現有資料**：不是 JSON、不是這個 App 的備份、
  版本比程式新、`data` 不完整、一個認得的鍵都沒有 —— 每一種都有各自的中文訊息。
- **`BACKUP_KEYS` 同時是白名單**，手改過的備份檔塞不進別的 localStorage 鍵。
- 還原成功之後**重新整理頁面**：設定與複習進度都有模組層級的快取，
  重載是唯一能保證每個模組都看到新資料的做法。

> 檔名是全 ASCII 的 `speaking-coach-backup-YYYYMMDD.json`。原本寫成中文的
> 「備份」兩個字，**Chromium 會直接忽略整個 `download` 屬性**、把檔案存成
> 沒有副檔名的 `download`（用 Playwright 抓 `suggestedFilename()` 才發現）。

### 🎧 聽力 ／ ✍️ 中翻英 ／ 💬 情境對話

題目與例句都是**開發時寫好的靜態檔**，不做執行期 AI 生成 ——
執行期少一個失敗點，也不必為了出題付 API 費用。

中翻英的自由作答用 `lib/grade.js` 在前端批改（正規化後比對關鍵字與長度），
不呼叫任何 API。

### 🗣️ 跟讀

這個模式是整合的落點，也是唯一會呼叫 API 的模式。詳見下一節。

### ⚙️ 設定

金鑰、練習範圍（情境與難度，八種情境的清單從 `lib/labels.js` 長出來）、
中文講評的開關、講評用的 model、TTS 語音與語速、學習資料的清除。

---

## 跟讀模式：練習紀錄會回頭決定下一句

練習紀錄在這裡不只是「看過的清單」。下一句抽什麼由三件事相乘決定：

```
權重 = 分數權重 × 該複習了沒 × 這句練不練得到你的弱點
```

規則全部在 `public/lib/practice.js`，**刻意只放純函式**（不碰 DOM、不碰 localStorage），
`npm test` 才能直接在 Node 裡跑 3,000 次抽樣驗機率分布 ——
加權調錯的症狀是「一直重複同幾句」或「某幾句抽不到」，那種東西用眼睛看很難發現。

### ① 分數權重

| 狀態 | 基礎權重 |
|---|---|
| 練過，平均 0 分 | 5 |
| 練過，平均 50 分 | 3 |
| 沒練過 | 3 |
| 練過，平均 100 分 | 1 |

沒練過的給 3：比「練得好」高（要鼓勵覆蓋沒碰過的句子），比「練得爛」低。

**最低是 1 而不是 0**，這一點比加權本身更重要 —— 練得好的句子只是變罕見，
不會從池子裡消失。權重歸零的話某幾句會再也抽不到，那比完全不加權還糟。

### ② 該複習了沒（間隔重複）

只看分數有個很明顯的破綻：**剛剛才練完的句子，下一秒還是「最該練」的那一句**。
反過來，練到 95 分的句子一旦沉下去就再也不回來，但發音擱兩個星期是會退的。

複習間隔由分數決定，**每差 25 分就差一倍**：

| 平均分數 | 下次該練的間隔 |
|---|---|
| 0 分 | 6 小時 |
| 50 分 | 24 小時（基準） |
| 100 分 | 96 小時 |

用指數而不是線性，是因為「練得好」與「練得爛」該有數量級的差距 ——
只差兩倍的話，練到 90 分的句子隔天照樣一直冒出來。

係數是 **0.25～2 的連續值**（`1 - e^-x`，x 是「過了幾個間隔」），不是到期／沒到期的二分法。
剛練完 0.25，到了該複習的時間點約 1.36，拖很久趨近 2。

沒做完整的 SM-2：那一套的輸入是使用者自評「記得／不記得」，
而這裡每次練習本來就會拿到一個 0～100 的客觀分數，直接拿它決定間隔就夠了。

### ③ 這句練不練得到你的弱點

`content/sentences.json` 的每一句都標了 `focus`（這句在練哪些音）。
把最近 30 筆紀錄裡的問題音統計起來，一句話涵蓋你越多問題，倍率越高（1～2 倍）。

只看最近 30 筆是刻意的：一年前就改掉的問題不該一直綁住現在的練習。
下限一樣是 1 而不是 0 —— `focus` 是人工／自動標的，本來就不會完美，
全部只餵弱點音會讓練習變得很窄。

**弱點是從真實評分算出來的，不是猜的。** Azure 回的是每個音素的分數，
`lib/azure-issues.js` 把它翻成分類：

| Azure 給的 | 對應到 |
|---|---|
| θ / ð 分數低 | `th` |
| ɹ / l 分數低 | `r_l` |
| v / w 分數低 | `v_w` |
| ŋ 分數低 | `n_ng` |
| i / ɪ / u / ʊ / æ / ɛ / e 分數低 | `vowel_length` |
| 字尾的 p b t d k ɡ 分數低 | `final_consonant` |
| `errorType: Monotone` 或語調分數低 | `stress` |
| `errorType: UnexpectedBreak` / `MissingBreak` | `linking` |

判斷順序是刻意的：**先看具體的音素，再看字層的錯誤類型**。「th 唸錯」比
「這個字準確度低」有用得多，反過來排的話具體資訊會被蓋掉。幾個刻意的取捨：

- **不收 `n`，只收 `ŋ`。** n 在英文裡太常見，一旦誤判就會把所有問題都算成 `n_ng`。
- `Insertion`（多唸一個字）**不對應** `extra_vowel`。後者指的是字尾多加母音
  （and 唸成 an-de），是音素層的事，硬對過去會讓弱點統計失真。
- `Omission`（漏字）不列進弱點：那是「沒唸」不是「唸錯」。
- `heard`（你唸成什麼）留空。Azure 給分數，不給那個資訊 ——
  硬要從 recognizedText 猜哪個字對哪個字只會編出錯的東西。

### 看得見，不然使用者只會覺得壞了

三個維度都在影響抽句，不寫出來就完全看不出來：

- 句子旁：`練過 3 次・平均 82 分・10 天前・該複習了`（到期那段是琥珀色）
- 命中弱點時：`這句在練 th 音`（綠色 —— 它講的是「這句對你有用」，
  不是「你又錯了」；紅色在這頁已經是「唸錯的字」的意思）
- 一組練完的總結會說「接下來會多抽一些練得到這些音的句子」

加權可以在模式裡直接關掉，關掉就退回等機率隨機 ——「怎麼一直抽到同幾句」要有辦法關掉。

### 每日目標、連續天數、一組 5 句

練習紀錄回答的是「我練得怎麼樣」，但**沒有回答「我今天練了嗎」**。

- **今天的進度**：今天幾句 / 目標幾句（可選 3/5/10/20）。達標時數字才變綠 ——
  平常就是彩色的話，達標與否就看不出差別。
- **連續天數**：**今天還沒練不會馬上歸零**，從昨天開始往回算；前天以前才練過才是 0。
  早上打開看到「連續 0 天」會讓人覺得昨天的努力已經沒了，而那正好是最不該讓人放棄的
  時間點。說明文字也一律不寫「你今天還沒練，連續天數要斷了」——
  用罰的去推人回來短期有效，長期只會讓人不想打開。
  一天的界線用**本地時間**切（用 UTC 的話台灣晚上八點以後練的都會被算成隔天）。
- **一組 5 句**：「換一句、再換一句」是沒有終點的，很容易練兩句就關掉。練完給一份總結：
  句數、平均、最高最低，以及**這一組最常出現的問題類型**。
  最後那一項才是重點 ——「五句裡有三句都是 th」是可以拿去練的結論，「平均 72 分」不是。

### 中文意思

匯入的句子附中文翻譯（Tatoeba 的，用 OpenCC 轉成台灣正體），顯示在句子下面。
知道自己在說什麼，練起來才不是在唸音節。早期手寫的句子沒有中文，就不顯示那一行。

---

## 無人聲偵測（為什麼不能相信模型自己判斷）

**踩到的問題：** 送一段完全沒有人聲的錄音給 Gemini，它會把提示裡的目標句原封不動
當成「聽到的內容」回傳，給 95～98 分，還稱讚「雙元音發得相當到位」。

這不是 prompt 沒寫清楚。加上 `speech_detected` 布林欄位、把判斷步驟拉到最前面、
明講「你看得到目標句但那不是你聽到的內容」之後，用**純數位靜音**實測：

| | 3.7-flash | 3.6-flash | 3.5-flash | 3.5-flash-lite | 3.1-flash-lite |
|---|---|---|---|---|---|
| 合成噪音 | ❌ 95 分 | ✅ 0 分 | ❌ 95 分 | ✅ | ✅ |
| 純數位靜音 | ❌ 95 分 | ❌ 98 分 | ❌ 95 分 | ✅ | ✅ |

五個 model 有三個照樣給高分。**結論：這件事不能交給模型判斷。**

所以改成在呼叫任何 API 之前，直接用訊號本身判斷（`server/audio.js`）：

| 指標 | 門檻 | 擋掉什麼 |
|---|---|---|
| 峰值 | `< 0.02`（約 -34 dBFS） | 靜音、麥克風沒收到音 |
| 有聲音框佔比 | `< 2%` | 整段幾乎都是空的 |
| 音量變異係數 | `< 0.08` | 音量夠大但從頭到尾不變的嗡嗡聲／電流聲 |

三個指標任一命中就直接回「沒聽到人聲」，**兩條路徑都不呼叫**。
Azure 對靜音會正確回 `NoMatch`，但一樣是白跑一趟 —— 免費層併發數很低。
擋掉之後不計入練習紀錄，也不顯示成「0 分」——「沒錄到東西」跟「發音很差」
給使用者的訊息完全不同。

門檻是拿**真實語音**校準的：真人語音的變異係數實測約 1.19，穩定正弦波約 0.008，
中間差兩個數量級；音量降到原本的 5%（很小聲但聽得到）仍然通得過。

前端 `lib/wav-encoder.js` 有一份等價的檢查，那份是為了即時提示與省一次上傳 ——
**後端那份才是把關**，因為前端送什麼上來都不能信。兩邊的門檻值要一起改。

---

## 句庫從哪裡來

### 練習句：Tatoeba + 手寫面試句

`npm run sentences:import` 從 [Tatoeba](https://tatoeba.org/) 的中英句對匯入。
選它的理由是**它本來就是給語言學習者用的例句庫**：短、口語、現代，而且附中文翻譯。
資料透過 npm 套件 `tatoeba-sentence-pairs-in-mandarin-chinese-english` 取得
（7.6 萬組），不用手動下載。

> **出處與授權：** 練習句來自 [Tatoeba](https://tatoeba.org/)，授權
> [CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/)。

八種情境，每種 230～280 句：

| 情境 | 句數 | | 情境 | 句數 |
|---|---|---|---|---|
| 日常對話 | 278 | | 學習 | 250 |
| 旅遊 | 272 | | 健康 | 250 |
| 職場 | 263 | | 購物 | 250 |
| 餐飲 | 250 | | 面試 | 228 |

**面試那 228 句是手寫的**（`data/interview.txt`）。Tatoeba 的面試類句子只有 95 句
（其他情境都上千）—— 通用語料本來就不會有「What does success look like in the first
three months?」這種東西，而這一類剛好是最該有品質的。要自己加句子也走這條路：
在 `data/` 放一個 `<情境>.txt` 就會被收進去，難度與 `focus` 自動算，
不通過清洗會印出原因。

`QUOTA`（每個情境 250 句）算的是**這個情境總共要幾句**，不是這一次要收幾句 ——
所以句庫滿了之後重跑會印「新增 0 句」，不會再疊上去。
（原本是從 0 起算的，句子有去重所以不會出現重複句，症狀只是句庫安靜地膨脹到兩倍：
daily 從 278 變 528。這種「跑起來沒報錯、資料悄悄壞掉」的東西最難發現，
所以現在 `--write` 之前先看那一行印出來的數字。）

清洗（7.6 萬組句對 → 通過清洗 16,520 句 → 去重後 15,310 句候選 → 依配額收進句庫）
擋掉的都是「文法沒錯但練口說沒意義」的：

| 擋掉什麼 | 為什麼 |
|---|---|
| 5 字以下、13 字以上 | 太短練不到連音，太長一口氣唸不完 |
| 句首是專有名詞 | Tatoeba 有 **5,825 句以 Tom 開頭**。判斷方式是「這個字在語料裡會不會以小寫出現」—— `Tom` 不會，`Please` 會；寫死人名清單永遠會漏 |
| 句中出現大寫字 | 專有名詞。句子會變得很特定 |
| 第三人稱敘事（he／she） | 「He left his office in a hurry.」是在講故事，不是在對話 |
| `said`／`replied`、`But`／`So` 開頭 | 這句原本有前一句，單獨看不成立 |
| 古語與古英文語序 | 混進來整份句庫會讀起來像老小說 |
| 阿拉伯數字 | 目標句要跟聽到的內容**逐字比對**，「300,000」唸出來是什麼取決於使用者怎麼讀 |
| 令人不舒服的內容 | 「An old woman was burnt to death.」通過了上面每一道清洗，但沒有人想在練發音時唸這句 |

內容過濾用的是關鍵字，那是**鈍器**：擋不掉全部，也一定會誤傷。所以清單只放
「出現了幾乎一定不合適」的字 —— `afraid` 就不能放進去，不然
「I'm afraid my luggage didn't arrive」跟「Don't be afraid to ask questions」都會被砍掉。

### 自動標「這句在練哪些音」

`scripts/phonetics.js` 用 [CMU 發音字典](https://github.com/cmusphinx/cmudict)（13.5 萬字）查音素。

第一版寫成「句子裡有 TH 就標 th」，拿人工標的 81 句當對照：命中 90%，
**但每句被多抓 5～7 個** —— 因為隨便一句英文都含 R 和 L、都有字尾子音。
標籤掛滿等於沒有標籤。

所以改成算**密度**，而且**除以那個音在語料庫裡的平均**再比。`final_consonant`
的平均是 `v_w` 的**十二倍**，兩者的絕對分數本來就不能直接比。正規化之後比的是
「比一般句子強多少倍」，只留最強的兩個、且要超過 1.6 倍。
基準線由 `npm run corpus:baseline` 重算，換語料庫要重跑。

用同一套規則把原本人工標的 81 句重標，**74 句有變**。多數不是演算法比較笨，
是人工標的本來就錯 —— 例如把「I usually grab a coffee on my way to work.」標成 `v_w`，
但那句只有 W 沒有 V，**根本練不到 v／w 的分辨**，畫面上卻會出現「這句在練 v / w」。

### 單字庫：ECDICT

`npm run build:vocabulary` 從 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT）
產生單字庫（沒有 `ecdict.csv` 就自動下載，約 63 MB；`--csv` 可以指到現成的檔案，
`--out` 可以先產到別的目錄對照）。原始資料很髒：釋義是簡體、音標混用非 IPA 字元
（`ә` 是西里爾字母、`^` 其實是 `ɡ`、`\` 是 `ɜ`），清理邏輯都在
`scripts/build-vocabulary.mjs`，改那個檔前先讀註解。

同一批字寫出兩種切法（`band-NN.json` 與 `tier-N.json`），所以字庫在磁碟上是
**兩份、共約 7 MB**。刻意用重複的檔案換簡單：前端一個牌組只 fetch 一個檔案，
不必在伺服器啟動時把 3 MB 讀進記憶體再依難度重組。

⚠️ **兩個踩過的雷**：
- **`curated.json` 是手寫的，不由腳本產生。** 腳本原本會 `rmSync` 整個
  `content/vocabulary/`，重跑一次就把它刪掉；而 index.json 少了 curated 那一項，
  App 的預設牌組就載不到。現在只刪自己產生的檔名。
- **腳本寫的欄位叫 `bands`，App 讀的是 `decks`。** committed 的 index.json 是後來
  手改的，跟腳本的輸出不一致 —— 重跑就會壞。現在腳本直接輸出 `decks`
  （精選 + 6 個分級 + 10 個級距），`vocabulary.test.js` 有一條釘住這件事。

重跑之前先確認 **band 的字與 id 沒有跑掉**：那些 id 就是使用者的複習進度鍵。
做法是先 `--out` 到暫存目錄，再比對 `word` 與 `id` 的序列（這次重跑比對過，
既有欄位一個都沒變，只多了 `tier` / `collins` / `oxford`）。

### 評估過但沒有採用的來源

| 來源 | 授權 | 為什麼沒用 |
|---|---|---|
| [Mozilla Common Voice](https://github.com/common-voice/common-voice) 的 `server/data/en` | **CC0** | 6.1 萬句、授權更寬鬆，但多半來自公版小說。過濾到剩三千句還是有一半讀起來像十九世紀對白（"Are you a beast of the field?"） |
| Common Voice 的 `wiki.en.txt` | CC0 | 維基百科條目，不是對話 |
| [Harvard／IEEE 720 句](https://en.wikipedia.org/wiki/Harvard_sentences) | 公有領域 | 音素平衡，但是為了測電話線路設計的（"The birch canoe slid on the smooth planks"） |

**授權寬鬆不等於內容合用。**

---

## 錯誤處理

所有失敗情境都會在前端顯示繁體中文的說明，講清楚該做什麼，不會只丟 error code。

| 情境 | HTTP | 說明 |
|---|---|---|
| 兩組金鑰都沒設定 | 500 | 伺服器啟動時也會在 console 警告 |
| Gemini 金鑰格式不對 | 401 | 送出前先擋掉，不浪費一次呼叫 |
| Gemini 金鑰無效 | 400 | **注意：Gemini 對無效金鑰回的是 400 不是 401**，而且訊息裡看不到 `API_KEY_INVALID`，所以 400 的說明會同時提示金鑰與音檔兩種可能 |
| Azure 金鑰／區域錯誤 | 401 | |
| Azure 聽不出任何內容 | 422 | 通常是錄音裡沒有清楚的英文 |
| Azure 併發超限 | 429 | 免費層的併發數很低 |
| 額度用盡 | 429 | |
| 服務異常 | 502 | |
| 逾時 | 504 | Gemini 60 秒、Azure 30 秒 |
| 錄音檔超過 8 MB | 413 | |
| model 不在白名單 | 400 | 前端只送得出清單內的值，這關擋的是繞過 UI 的呼叫 |
| 錄音裡沒有人聲 | 200 | 不算錯誤：回 `speech_detected: false`，不呼叫任何 API、不計入紀錄 |
| 麥克風權限被拒／找不到裝置／被占用 | — | 前端各自對應不同提示 |
| 瀏覽器不支援 `MediaRecorder`／非 secure context | — | 模式內橫幅提示 |
| `localStorage` 不可用（無痕模式等） | — | 紀錄靜默停用，其他功能照常 |

完整的錯誤內容只寫進伺服器 console，回給前端的訊息不含金鑰或 stack。

---

## 架構

```
english_speaking/
├── .env                       # 你自己建立（已 gitignore）
├── .env.example
├── Dockerfile                 # 只裝正式相依套件的執行映像檔
├── docker-compose.yml         # App + Caddy（補 HTTPS，手機才能用麥克風）
├── docker-compose.duckdns.yml # 憑證改用 Let's Encrypt + DuckDNS 的疊加設定
├── Caddyfile / Caddyfile.duckdns
├── .github/workflows/ci.yml   # 每次 push 跑 npm test 與 npm run test:ui（都不需要金鑰）
├── content/
│   ├── sentences.json         # 2,041 句練習句：id / text / category / difficulty / focus / zh
│   ├── listening.json         # 81 組 / 226 題
│   ├── translation.json       # 279 題
│   ├── dialogues.json         # 61 段 / 427 句台詞
│   └── vocabulary/            # index + tier-map + curated + tier-1..6 + band-01..10
│                               #（同一批 10,000 字的兩種切法，加手寫的精選 40 字）
├── data/
│   └── interview.txt          # 手寫的面試句（一行一句，# 是註解）
├── scripts/
│   ├── phonetics.js           # 用 CMU 發音字典判斷「這句適合練哪些音」（純函式）
│   ├── import-sentences.mjs   # 從 Tatoeba 匯入，自動標 focus 與難度
│   ├── corpus-baseline.mjs    # 重算 phonetics.js 的基準線
│   ├── vocab-levels.js        # 單字的難度分級規則（純函式，腳本與測試共用）
│   ├── build-vocabulary.mjs   # 從 ECDICT 建單字庫（band + tier 兩種切法）
│   └── generate-content.mjs   # 題庫生成與**結構驗證**
├── server/
│   ├── index.js               # Express：靜態檔、內容端點、發音評估、設定
│   ├── azure-pronunciation.js # Azure Speech 發音評估（逐字、逐音素）
│   ├── gemini.js              # Gemini：講評 + 沒有 Azure 時的主觀評分、model 白名單
│   ├── audio.js               # WAV 能量分析，判斷有沒有人聲
│   ├── narration.js           # 講評開關 + 沒用 Gemini 時的本地摘要（純函式）
│   └── settings.js            # 從設定頁寫 .env（只接受 loopback）
├── public/
│   ├── index.html
│   ├── app.js                 # 應用外殼：模式切換
│   ├── style.css
│   ├── lib/
│   │   ├── dom.js             # h() 與會過濾的 append()
│   │   ├── practice.js        # 間隔重複、弱點音加權、連續天數、一組總結（純函式）
│   │   ├── azure-issues.js    # Azure 音素分數 → 弱點音分類（純函式）
│   │   ├── text-diff.js       # 目標句與聽到的內容做 LCS 逐字比對（純函式）
│   │   ├── labels.js          # 顯示字串、分數門檻、發音問題的中文標籤
│   │   ├── grade.js           # 中翻英的前端批改
│   │   ├── recorder.js        # 麥克風與 MediaRecorder
│   │   ├── wav-encoder.js     # 錄音 → 16 kHz 單聲道 WAV + 音量分析
│   │   ├── waveform.js        # AnalyserNode 即時波形
│   │   ├── tts.js             # 示範發音
│   │   ├── today-card.js      # 今天練了幾個 + 連續天數（單字卡與跟讀共用）
│   │   ├── quiz.js            # 單字選擇題的出題與干擾項規則（純函式）
│   │   ├── backup.js          # 學習資料的備份檔：組出來、讀回去、以及還原前的把關
│   │   ├── storage.js         # localStorage：單字 SRS、每日計數表、練習紀錄
│   │   ├── settings.js        # 前端偏好設定
│   │   ├── stat-tile.js / trend-chart.js
│   └── modes/
│       ├── vocabulary.js / listening.js / translation.js / dialogue.js
│       ├── shadowing.js       # 跟讀（整合的落點）
│       ├── shadowing-views.js # 今天的進度、一組總結、練習紀錄
│       ├── assessment-view.js # 發音評估的呈現（Azure 與 Gemini 兩種形狀）
│       └── settings.js
└── test/                      # 見「測試」
```

### API

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/health` | `{ ok, azureConfigured, geminiConfigured }` |
| GET | `/api/models` | Gemini model 白名單與預設值 |
| GET | `/api/content/:name` | `sentences` / `listening` / `translation` / `dialogues` |
| GET | `/api/vocabulary/:file` | `index.json` / `tier-map.json` / `curated.json` / `tier-N.json` / `band-NN.json`。檔名形態是白名單（避免路徑穿越），形態合法但檔案不存在回 404 |
| GET | `/api/sentences` | 307 轉到 `/api/content/sentences`（舊路徑，口說分支用過） |
| GET / POST | `/api/settings` | 讀寫金鑰設定（**只接受 loopback**） |
| POST | `/api/pronunciation-feedback` | multipart：`audio`（WAV）+ `sentence` + `model`（選填）+ `narrate`（選填，`off` 表示不要 Gemini 講評） |

`/api/pronunciation-feedback` 有 Azure 時回：

```json
{
  "provider": "azure",
  "referenceText": "I think so.",
  "recognizedText": "I sink so.",
  "scores": { "pronunciation": 72, "accuracy": 68, "fluency": 85,
              "completeness": 100, "prosody": 55 },
  "words": [
    { "word": "think", "accuracy": 40, "errorType": "Mispronunciation",
      "phonemes": [{ "phoneme": "θ", "accuracy": 20 }] }
  ],
  "feedback_zh": "• …",
  "narrationSource": "gemini",
  "narrationReason": null,
  "narrationMs": 4200
}
```

`narrationSource` 是 `"gemini"` 或 `"local"`；`narrationReason` 說明講評為什麼不是
Gemini 寫的，前端據此決定畫面上那行小字（四種說法各不相同，混成一句話
使用者會以為壞了）：

| `narrationReason` | 意思 |
|---|---|
| `null` | 講評是 Gemini 寫的，`narrationMs` 是這次等了幾毫秒 |
| `"disabled"` | 使用者自己關掉了（前端送了 `narrate=off`），**沒有呼叫 Gemini** |
| `"no_key"` | 伺服器沒設定 `GEMINI_API_KEY` |
| `"failed"` | 呼叫了但失敗或超時，已退回本地摘要（分數不受影響） |
| `"gemini_scores"` | 關掉了講評，但沒設定 Azure，分數本身就是 Gemini 給的 —— 省不到時間 |

沒有 Azure 時退回 Gemini 的主觀評分（`provider: "gemini"`，含 `score`、`transcript`、
結構化的 `problem_words`）。沒偵測到人聲時回 `speech_detected: false` 與 `gated_by: "silence"`。

### 為什麼錄音要轉成 16 kHz 單聲道 WAV

Gemini 的兩份官方文件對 `audio/webm` 的支援說法不一致，而那正好是 `MediaRecorder`
的預設輸出。後來確認 `@google/genai` 的 `AudioContentMimeType` 型別裡**完全沒有** webm。

`MediaRecorder` → `blob.arrayBuffer()` → `decodeAudioData()` → `OfflineAudioContext`
重取樣成單聲道 16 kHz → 自己寫的 44-byte RIFF header 編成 16-bit PCM WAV。

附帶好處：**Azure Speech SDK 的預設輸入格式正好也是 16 kHz 16-bit 單聲道 PCM**，
接上 Azure 時音訊管線一個 byte 都不用改。而且 Safari 吐的是 mp4/aac 而非 webm，
走這條路兩邊格式就統一了。

### 為什麼不用 Web Speech API 做辨識

`SpeechRecognition` 只接受**即時**麥克風輸入，介面上沒有任何方式可以餵進錄好的
File / Blob，所以「錄完再拿去辨識」這條路不存在。而且 Chrome 的實作是送到 Google
伺服器辨識、MDN 標記為 "Limited availability"、Firefox 支援有問題。

---

## 用 Docker 跑在自己的機器上

想在**手機上練**（口說練習的實際場景多半在手機），就得解決一件事：
`getUserMedia` 只在 secure context 下可用，也就是 `localhost` 或 `https://`。
從別的裝置連 `http://10.0.0.5:3000` 的話，麥克風會被瀏覽器直接擋掉。

所以用兩個容器：App 本身，加上在前面補 HTTPS 的 [Caddy](https://caddyserver.com/)。

```bash
cp .env.example .env
# 編輯 .env：金鑰、SITE_ADDRESS（你會用哪個位址連過來）、BIND_ADDR

docker compose up -d --build
```

然後從同一個網路（VPN 或區網）的裝置開 `https://<SITE_ADDRESS>:8443`。

| 檔案 | 做什麼 |
|---|---|
| `Dockerfile` | 只裝正式相依套件。devDependencies 裡的 Tatoeba 語料有 7 MB，那是匯入句子時才用的 |
| `Caddyfile` | HTTPS、gzip（`content/sentences.json` 有 450 KB）、反向代理 |
| `docker-compose.yml` | 兩個服務。**App 刻意不對外開埠** —— 直接開 3000 的話那條路是 http，麥克風照樣不能用，只會讓人以為壞了 |

> 容器裡**沒有** `.env`（Dockerfile 不複製它），金鑰是靠 compose 的 `environment:`
> 從主機的 `.env` 轉進去的。所以**程式碼開始讀一個新的環境變數時，compose 也要跟著加**
> —— 漏了的話容器照樣起得來、healthcheck 照樣過，只有那個功能安靜地死掉。
> （真的發生過：階段 11 接上 Azure 之後，compose 的 `environment:` 只列了 Gemini 那兩個，
> 於是走 Docker 部署時 `.env` 填了 Azure 金鑰也進不到容器裡。）
> 檢查方式：
>
> ```bash
> grep -rhoE "process\.env\.[A-Z_]+" server public | sort -u
> ```

`BIND_ADDR` 決定埠綁在哪個介面：填 VPN 介面的 IP，區網與公網那一側就掃不到。
留空會綁 `0.0.0.0`，**這個 App 沒有帳號密碼也沒有 rate limit，不要就這樣放在有公網的機器上。**

### 憑證：兩條路

**① Caddy 自己的本機 CA（預設，不需要網域）**

`Caddyfile` 裡的 `tls internal`。Caddy 會自己簽，**連 IP 位址都簽得出來**，
所以 `SITE_ADDRESS` 直接填 VPN 的內網 IP 就行。代價是每台裝置都得裝一次根憑證：

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

- **Android**：設定 →「安全性」→「加密與憑證」→「安裝憑證」→「CA 憑證」
- **iOS**：傳過去安裝成描述檔，**然後還要**到設定 →「一般」→「關於本機」→
  「憑證信任設定」把它打開 —— 少了這一步不會生效，而且 iOS 不會告訴你原因

> ⚠️ `caddy_data` 這個 volume 裡有本機 CA 的私鑰。**刪掉它等於換一張 CA**，
> 每台裝置都要重裝根憑證。

> **另一個雷：SNI 規格不允許放 IP**（RFC 6066），所以瀏覽器連
> `https://<IP>:8443` 時**不會送 SNI**。Caddy 的退路是拿連線的本機 IP 去找憑證，
> 但在 Docker 的埠轉發後面，容器只看得到 172.x 的內部位址，比對不到就直接回
> TLS alert 80 斷線 —— 瀏覽器只顯示「無法安全連線」，Caddy 的 log 裡也沒有線索。
> `Caddyfile` 用 `default_sni` 解掉這件事。
>
> 測試時還有一個陷阱：**Windows 內建的 `curl.exe` 走 schannel，對純 IP 做 TLS
> 一定失敗**（`SEC_E_INTERNAL_ERROR`），看起來像服務壞了其實沒有。
> 要用 `openssl s_client -noservername` 才驗得準。

**② Let's Encrypt（比較省事，而且網域可以是免費的）**

```bash
docker compose -f docker-compose.yml -f docker-compose.duckdns.yml up -d --build
```

走 **DNS-01 挑戰**，所以**不需要對外開 80／443** ——
[Let's Encrypt 驗的是「你控制這個網域」，不是「這個 IP 連得到」](https://letsencrypt.org/docs/challenge-types/)，
A 記錄指向 VPN 的內網 IP 也照樣簽得出來。好處是每台裝置都直接信任，不用裝根憑證。

免費網域兩個選擇（要的其實不是「網域」，是**一個你能寫 TXT 記錄的 DNS 名字**）：

| 服務 | 名字 | 說明 |
|---|---|---|
| [DuckDNS](https://www.duckdns.org/) | `你的名字.duckdns.org` | 免費、5 個子網域、有官方 [caddy-dns 模組](https://github.com/caddy-dns/duckdns)。**A 記錄可以指向私有 IP** |
| [deSEC](https://desec.io/) | `你的名字.dedyn.io` | 非營利、完整 API 與 DNSSEC。要**萬用字元憑證**用這個 —— DuckDNS 一次只存得下一筆 TXT |

> ⚠️ **不要用 `.tk` / `.ml` / `.ga`。** 提供它們的 Freenom
> [在 2024 年退出網域生意](https://domainincite.com/29668-freenom-shuts-down-12-6-million-domains-report)，
> 約 1,260 萬個網域直接停止解析。網路上很多舊教學還在推薦它。

`duckdns.org` 與 `dedyn.io` 都在 [Public Suffix List](https://publicsuffix.org/) 上
（實際抓下來確認過），所以 Let's Encrypt 的速率限制**各子網域各算**。

DuckDNS 的 A 記錄要指向內網 IP —— 網頁上的欄位會自動填你的**公開** IP，用 API 明確指定：

```bash
curl "https://www.duckdns.org/update?domains=my-speaking&token=<你的token>&ip=10.0.0.5"
```

要退回自簽憑證：`docker compose up -d`（不帶 override）。

> ⚠️ **DuckDNS 的權威 nameserver 不回應 TCP/53**，而 Caddy 預設會繞過遞迴解析器、
> 直接去問權威 NS「`_acme-challenge` 的 TXT 出現了嗎」。於是那個檢查永遠做不完，
> Caddy 就一直不通知 Let's Encrypt 來驗證，卡在這個重試迴圈裡：
>
> ```
> could not get certificate from issuer ... checking DNS propagation of
> "_acme-challenge.<name>.duckdns.org." ... dial tcp 99.79.16.64:53: i/o timeout
> ```
>
> 排除過防火牆：從同一個容器連 `1.1.1.1:53`（TCP）與 `1.1.1.1:443` 都通，
> 只有 DuckDNS 的 NS 連不上。`Caddyfile.duckdns` 的解法是 `resolvers 1.1.1.1 8.8.8.8`
> ＋ `propagation_timeout -1`（關掉檢查）＋ `propagation_delay 60s`（改成固定等待）。
> 改完重啟，50 秒就拿到憑證。
>
> 這類失敗發生在**通知 LE 之前**，所以不會消耗失敗驗證的額度；但 delay 設太短
> 而導致真的驗證失敗就會 —— 所以寧可設寬一點。

### 沒有做的事

- **沒有帳號密碼、沒有 rate limit。** 現在的假設是「只有 VPN／區網內的自己人連得到」。
  要放公開網址的話這兩件事是必須的 —— 後端拿著你的金鑰，一個迴圈就能把免費層打光。
- **學習資料仍然只存在瀏覽器裡。** 手機和電腦的紀錄不會合併，連續天數也是各算各的。

---

## 測試

### CI

`.github/workflows/ci.yml` 在每次 push 與 PR 上跑 `npm test`（Node 20 與 22）
以及 `npm run test:ui`（起伺服器 + Playwright）。**兩者都不需要金鑰。**

`test/e2e.mjs` 不掛進 CI —— 它有一部分要金鑰、會吃配額，掛上去等於每次 push
都在燒配額，額度用完那天 CI 會紅得莫名其妙。

### 單元測試（201 項，不需要網路與金鑰）

```bash
npm test
```

| 檔案 | 驗什麼 |
|---|---|
| `audio.test.js` | 無人聲門檻。**兩個方向**：該擋的要擋（靜音、極低噪音、平穩嗡嗡聲），以及**真實語音在各種音量下都不可以被擋**（誤擋比原本的 bug 更糟）。正向樣本用真實語音而不是合成訊號 —— 合成訊號的能量分布跟真人差太多，測不出誤擋 |
| `practice.test.js` | 間隔重複、弱點音加權、連續天數、一組總結。跑 3,000 次抽樣驗機率分布，**一律注入 `now`** —— 這些函式全部跟時間有關，用真實時鐘的話測試會在半夜跑的時候紅一次、隔天自己又好了 |
| `azure-issues.test.js` | Azure 音素 → 弱點音分類。其中一條釘住「每個對應出來的代碼都在 `ISSUE_CODES` 裡」—— 代碼會被拿去查中文標籤，漏一個就會讓代碼原文出現在畫面上 |
| `text-diff.test.js` | 目標句與聽到的內容逐字比對。特別測「漏唸中間一個字時只有那個字被標紅」（逐字對位的寫法會讓後面全部偏移、整句標紅） |
| `phonetics.test.js` | 自動標音。特別測「只有 w 沒有 v 的句子不可以標成 `v_w`」，因為那正是人工標的時候犯過的錯 |
| `gemini.test.js` | Gemini 回應的整理與防禦。structured output 有 schema，但 schema 是「請模型照這個格式」，不是「保證一定是這個格式」 |
| `narration.test.js` | 中文講評的開關與本地摘要。釘住「什麼樣的值算關掉」（沒送等於要，舊前端不受影響）與「四種缺席原因各講各的話」—— 把「你自己關掉的」跟「這次沒回來」寫成同一句，使用者會以為壞了 |
| `backup.test.js` | 備份檔。重點全部在**還原**那一側：匯出寫壞了頂多是檔案沒用，匯入寫壞了是把現有進度覆蓋成半殘的資料、而且沒有第二次機會。所以每一種壞檔案（非 JSON、別的 App、版本太新、`data` 被截斷、空檔案、手改塞進別的鍵）都有一條測試擋著 |
| `quiz.test.js` | 單字選擇題的出題。核心只有一條：**一題只能有一個正確答案** —— 干擾項跟答案同義的話，使用者選了「也對」的選項卻被判錯，比不做選擇題還糟。所以除了規則本身，還會拿真的字庫掃六個分級各 40 個字 × 兩個方向，逐一比對義項。另外釘住：選項文字不重複、湊不到干擾項要回 `null`（呼叫端退回翻卡）、壞掉的亂數不會卡住或少一個選項 |
| `vocabulary.test.js` | 單字的難度分級與每日進度。分級：規則本身（最簡單的標籤優先、沒標籤的用詞頻補位）、產出的資料（六個分級檔與 index.json 對得起來、兩種切法是同一組 id、tier-map 每一格都對）、以及**複習進度的鍵搬家**（`band-3:2001` → `ecdict:2001`，精選不動、重跑結果一樣、合併不會把人往回推）。搬家跑錯就是使用者的進度不見了，而且不會有錯誤訊息。每日進度：計數表只留最近 400 天、壞值當 0、連續天數與跟讀同一套算法、以及**鼓勵的話裡不出現威脅** |
| `sentences.test.js` | `content/sentences.json` 這份資料，以及匯入時的配額。擋的都是**錯了不會炸、只會安靜失效**的東西：`focus` 代碼打錯、id 重複、某個音的句子太少、某個情境＋難度的組合是空的、簡繁轉換踩到一對多陷阱、每個情境的句數跑出 200～300 之外、重跑匯入把句庫疊成兩倍 |

### 前端 UI 測試（141 項，需要伺服器，不需要金鑰）

```bash
npm start          # 另一個終端機
npm run test:ui
```

把假的練習紀錄塞進 `localStorage`，驗六個模式都載入得起來、今天的進度與連續天數、
練習紀錄與趨勢圖、重練這句、弱點音會回頭影響抽句、中文意思、加權不會餓死句子、
Azure 與 Gemini 兩條講評路徑、講評缺席時的四種說明、中文講評開關存不存得起來、
一組總結、設定頁、**單字卡的選難度與各級進度**（含舊進度搬家搬得對）、
**單字卡的每日目標**（練滿之後關掉重開不會重來、換難度不會歸零）、
**單字卡的選擇題**（答錯時同時標出正確答案與自己選的、答完不能改答案、
兩個方向的題目與選項語言對得起來、一種都沒勾會退回翻卡）、
**備份與還原**（真的下載一個檔案、把資料清光、再用那個檔案救回來）、清除紀錄。

講評與總結那兩段直接在頁面裡 `import` 模組餵資料進去 ——
走真實流程要金鑰也要錄音，而要驗的只是「拿到這樣的資料時畫成什麼」。

環境變數：`BASE`、`SHOTS`（存截圖的目錄）、`CHROMIUM`（指向現成的 Chromium 執行檔）。

### 瀏覽器端對端測試（需要伺服器；其中三段不需要金鑰）

```bash
npm start
npm run test:e2e
```

用 Chromium 的 `--use-file-for-fake-audio-capture` 把 WAV 檔當成麥克風輸入，
所以 `getUserMedia` → `MediaRecorder` → 轉 16 kHz WAV → 能量檢查 → 上傳 →
Azure／Gemini → 顯示講評 → 寫進 `localStorage` → 影響下一次抽句，整條路徑都是真的在跑。

**【1】【2】【4】不需要任何金鑰**（無人聲把關在後端呼叫 API 之前就擋掉了），
所以手上沒有金鑰也驗得到那幾段。【3】【5】沒金鑰時會自動跳過。

環境變數：`BASE`、`MODEL`（預設 `gemini-3.1-flash-lite`，最省配額）、`SHOTS`、`CHROMIUM`。

### 內容驗證

```bash
node --input-type=module -e "
import fs from 'node:fs';
const { TYPES } = await import('./scripts/generate-content.mjs');
for (const [t, spec] of Object.entries(TYPES)) {
  const items = JSON.parse(fs.readFileSync('content/' + spec.file, 'utf8'));
  const bad = items.filter((x) => spec.validate(x));
  console.log(t, items.length, bad.length ? '❌' + bad.length : '✅');
}"
```

> **解析不能只是把英文原句抄一遍加中文句號。** 這是這個專案裡反覆犯的錯，
> 三個聽力批次分別被驗證擋下 12、0、5 筆，全是同一個問題。新增內容一定要跑過這套驗證。

---

## 已知限制

- **直接 `npm start` 時必須用 `localhost` 開啟。** `getUserMedia` 需要 secure context；
  區網 IP 會被瀏覽器擋掉麥克風。要在手機上用請走 Docker 那條路。
- `speechSynthesis` 的語音品質取決於作業系統安裝的語音包，各平台聽起來不一樣。
- 單次錄音上限 60 秒，上傳上限 8 MB。
- **學習資料只存在這台瀏覽器**（單字 SRS、練習紀錄、設定）。換瀏覽器或清掉網站資料就沒了。
- **無人聲偵測擋得掉「沒有聲音」，擋不掉「有聲音但不是在唸這句話」。**
  播音樂、講中文都會通過門檻 —— 此時 Azure 會回 `NoMatch` 或很低的完整度，
  Gemini 則會誠實回報不符並給低分（實測在**有實際語音**的情況下判斷是準的）。
- **Azure 的實際呼叫在開發容器裡從來沒成功跑過** —— egress policy 擋掉
  `*.stt.speech.microsoft.com` 與 `*.api.cognitive.microsoft.com`（CONNECT 回 403），
  連認證失敗的路徑都測不到。已驗證的是 SDK 參數形狀（對照型別定義）、
  結果解析（用真實 Azure JSON 的 `NBest[0]` 結構）、以及前端渲染（mock 回應）。
  **使用者說在他本機測過可以動，但這裡沒有證據，不要假設它一定沒問題。**
- Prosody（語調）評估目前只支援 `en-US`。

## 在 WSL 上開發

建議把專案放在 **WSL 自己的檔案系統**（例如 `~/english_speaking`），不要放在 `/mnt/c/...` ——
`node_modules` 在 Windows 掛載點上讀寫會慢很多。

WSL2 有 localhost 轉發，所以在 WSL 裡 `npm start`、用 Windows 的瀏覽器開
`http://localhost:3000`，secure context 成立、麥克風可以用。

> `pkill -f "node server/index.js"` 會連自己的 shell 一起殺掉（exit 144），
> 改用 `ps` 找 PID 再 kill。

---

## 接下來

**一、拿真金鑰把 Azure 那條路跑完。** 這是目前唯一沒被實際驗證的一段，
而它現在是發音評分的主要路徑。`npm run test:e2e` 的【3】【5】就是為它寫的。

**二、手機版。** Docker + HTTPS 那條路已經能在手機瀏覽器上用了，
但介面還沒為觸控調整（觸控目標放大、單字卡適合單手操作、錄音按鈕移到拇指區）。
再往下有 PWA（加 manifest + service worker）與 Capacitor（可上架、麥克風是原生權限）
兩條路 —— 兩條都要先面對「介面在手機上順不順」，所以先做 PWA 比較划算。

**三、跨裝置的學習資料。** 手機和電腦各自存在自己的瀏覽器裡，分數不會合併、
連續天數也是各算各的。要解就得有後端儲存與帳號，面積比看起來大很多。

**四、幾個沒做完的小功能。** 情境對話的進度沒有存進 `localStorage`（重新整理就重來）；
單字卡的複習紀錄有寫入但沒有檢視畫面。

**五、公開部署要先補存取控制與 rate limit。** 後端拿著兩組金鑰，
公開網址等於任何人都能一直送錄音上來燒配額。

**六、`focus` 標籤與內容清洗都是啟發式的。** 擋得掉「不完整」與「不像對話」，
擋不掉「文法正確但沒人會這樣講」。要再往上就得有人看過，
或用 AI 做一次離線的品質評分（那是一次性成本，不是執行期的）。
