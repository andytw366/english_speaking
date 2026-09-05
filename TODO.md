# 交接筆記

給接手的新 session 用。**專案本身的說明全部在 `README.md`**（架構、每個設計決策的理由、
部署、測試怎麼跑），這裡只寫三件 README 不該放的東西：現在做到哪、下一步、
以及踩過而**不要重踩**的雷。

---

## 現況

分支 `claude/english-learning-app-review-vpfyhd`。

這個 repo 曾經有兩個平行發展的 App，占用同一批根目錄檔名：

- `claude/english-speaking-practice-app-vukgm7` —— **廣**：六種模式（單字、聽力、
  中翻英、情境對話、跟讀、設定）＋ Azure 發音評估
- `claude/english-learning-app-review-vpfyhd` —— **深**：把「口說」一種模式做透
  （間隔重複、音素級回饋、2,041 句句庫、CI、Docker + HTTPS 部署）

**已經整合完了**（階段 11-1 ～ 11-6）：以六模式為外殼，深的那一整套收進「跟讀」模式，
發音評分改用 Azure、Gemini 只負責把分數講成中文建議。兩邊的功能都沒有捨棄。

| 模式 | 內容 | 狀態 |
|---|---|---|
| 🗂️ 單字卡 | 10,040 字，**自己選難度**（6 級）＋各級進度＋**每日目標**＋**中英雙向選擇題**，Leitner 盒子制 | 完成 |
| 🎧 聽力 | 81 組 / 226 題 | 完成 |
| ✍️ 中翻英 | 279 題（填空 161 / 整句 118） | 完成 |
| 💬 情境對話 | 61 段 / 427 句台詞 | 完成 |
| 🗣️ 跟讀 | 2,041 句 / 8 種情境，Azure 逐音素評分 + 間隔重複 + 弱點音加權 + 連續天數 | 完成 |
| ⚙️ 設定 | 金鑰、中文講評開關、model、練習範圍、語音、學習資料 | 完成 |

驗證狀態：`npm test` 183 項全過、`npm run test:ui` 129 項全過、
`npm run test:e2e` 的【1】【2】【4】全過（【3】【5】要金鑰，會自動跳過）。
CI（`.github/workflows/ci.yml`）在 GitHub 上是綠的。

整合之後補的一件事：**中文講評（Gemini）現在可以在設定頁整段關掉**
（分支 `claude/gemini-speed-toggle-hzu9kw`）。理由是實際練起來最有感的等待
就是那一段 —— Azure 的分數、四個面向與逐音素標色都已經在畫面上了，
還要再等 Gemini 幾秒到十幾秒才看得到建議。關掉之後講評改用
`server/narration.js` 的本地摘要，Gemini 完全不呼叫。設計與各欄位的意思寫在
README「覺得慢？中文講評可以整段關掉」。

再一件（分支 `claude/gemini-speed-toggle-hzu9kw` 的第二個 commit）：
**單字卡改成自己選難度**。同一批 10,000 字現在有兩種切法 —— 依難度的 6 級
（`tier-1.json`…，考試標籤決定，規則在 `scripts/vocab-levels.js`）與原本依詞頻的
10 個級距（`band-NN.json`，留著，預設收起來）。選難度的畫面同時是各級進度總覽。
設計理由與資料細節在 README「🗂️ 單字卡」與「單字庫：ECDICT」。

接著把「一輪最多幾張」換成**每日目標**（設定裡的「單字卡每天練幾個字」，預設 20）：
選好難度之後每天從那一級抽固定數量，練完顯示今天完成了與連續天數，但不擋著不讓練。
關鍵是它算的是**日期**而不是場次 —— 舊的「一輪」關掉重開就再來一輪，等於沒有限制
任何東西。計數表在 `lib/storage.js`（`vocabDays`），卡片與話術跟跟讀共用
`lib/today-card.js`。

再一件：**單字卡改成中英雙向選擇題**（題型在設定裡可複選，預設兩種選擇題都開）。
原本規劃的是輸入式，查完資料後改成選擇題 —— 理由與規則在 README「🗂️ 單字卡」，
一句話版本：29% 的字跟別的字共用中文義項，打字會把「也對」的答案判成錯，
而選擇題可以把「義項不重疊」變成出題規則，順便讓間隔重複的訊號變客觀
（不再是使用者自己按「記得」）。

**這個開關的 Azure 那條路在容器裡驗不到**（egress 擋掉 Azure）。當時的做法是
用 `--import` 掛一個 loader 把 `server/azure-pronunciation.js` 換成假的，
再對真的伺服器發 `narrate=off` 與不送 `narrate` 兩次請求，確認回應的
`narrationReason` 是 `disabled` / `no_key`、分數照樣是 72。
**同一招可以用來驗任何走 Azure 分支的改動**，不用等真金鑰。

整合期間新長出來的檔案，接手前值得先看：

| 檔案 | 為什麼重要 |
|---|---|
| `public/lib/practice.js` | 抽句的全部規則（分數權重 × 該複習了沒 × 弱點音）。**純函式**，改這裡要跟著跑 `practice.test.js` 的機率分布測試 |
| `public/lib/azure-issues.js` | Azure 音素分數 → 弱點音分類。整合的接縫就在這裡：有了它，客觀分數才能回頭決定下一句抽什麼 |
| `public/modes/shadowing.js` | 深的那一套的落點。狀態多，改之前先讀檔頭 |
| `server/audio.js` | 無人聲把關。**後端這份才是把關**，前端那份只是即時提示 |
| `server/narration.js` | 講評開關（`wantsNarration`）與本地摘要。純函式，所以 `narration.test.js` 測得到 —— `server/index.js` 一 import 就 `app.listen()`，測不進去 |
| `scripts/vocab-levels.js` | 單字難度分級的**唯一一份**規則。建置腳本與 `vocabulary.test.js` 共用，改這裡要重跑 `npm run build:vocabulary` |
| `public/lib/storage.js` 的 `migrateSrs()` | 複習進度的鍵搬家（`band-3:2001` → `ecdict:2001`）。跑錯就是使用者的進度不見了，而且沒有錯誤訊息 |
| `public/lib/today-card.js` | 「今天練了幾個 + 連續天數」那張卡，單字卡與跟讀共用。改文案要想到兩邊 |
| `public/lib/quiz.js` | 選擇題的出題與干擾項規則。**「義項不重疊」那條是安全規則，永遠不能放寬** —— 放寬就會出現兩個都對的選項 |

---

## 待辦

盤點過六個模式之後重排的路線圖（2026-09）。排序的原則是**先把已經做出來的東西
接起來**，再加新的 —— 而不是繼續往單字卡上疊功能。

> **現在最大的結構性問題**：六個模式裡只有兩個有「進度」。
>
> | 模式 | 存進度 | 每日目標 | 連續天數 |
> |---|---|---|---|
> | 🗂️ 單字卡 | ✅ | ✅ | ✅ |
> | 🗣️ 跟讀 | ✅ | ✅ | ✅ |
> | 🎧 聽力 | ❌ | ❌ | ❌ |
> | ✍️ 中翻英 | ❌ | ❌ | ❌ |
> | 💬 情境對話 | ❌ | ❌ | ❌ |
>
> 聽力一組答完會顯示「答對 4 / 6」，但**關掉就沒了**；中翻英連答對幾題都沒算；
> 對話重新整理就從第一句重來。

### 第一階段：把六個模式接成一個系統

**1-a. 學習資料的匯出／匯入（先做這個 —— 這是防災，不是加值）**

現在 `localStorage` 裡有 10,000 字的複習進度、連續天數、跟讀紀錄，
而首頁自己就寫著「換瀏覽器或清除資料就會消失」。清一次全沒，而且**重建不出來**。
設定頁加「下載備份 / 還原備份」。

**1-b. 進度系統推到聽力、中翻英、情境對話**

計數表（`lib/storage.js`）與今天的卡（`lib/today-card.js`）都已經是共用的，
接上去主要是各模式在答完一題時記一筆。中翻英順便補「答對幾題」。

**1-c. 「今天」首頁**

現在有六個分頁，但沒有一個地方回答「我今天該做什麼」。首頁放各模式今天的進度、
連續天數、**待複習的字有幾個**，點一下跳進去。資料都有了，缺的只是一個畫面。

### 第二階段：日常手感

**2-a. 鍵盤操作** —— 選擇題按 `1`–`4`、`Enter` 下一題、空白鍵翻卡。
現在只有中翻英有 Enter（`translation.js` 的 `onEnter`）。桌機練起來差很多。

**2-b. 釋義截斷** —— 6% 的字釋義超過 60 字（`go` 有 20 個義項、`make` 19 個），
答完題後那一坨會蓋掉重點。只顯示前幾個義項＋「看全部」。

**2-c. 手機（PWA）** —— 現在只有**一個** 480px 的 media query、沒有 manifest、
沒有 service worker、連 favicon 都沒有（console 一直有一筆 404，`test/ui.mjs`
還特地繞過它）。加 manifest + 圖示 + 觸控目標放大，就能加到主畫面像 App 一樣開。
之後要包 Capacitor 是加一層殼，這一步不會浪費。

> **金鑰放哪裡**：現在在伺服器的 `.env`。走 Docker 就沿用這個，不用改。
> 真的要做成獨立 App 的話，讓使用者自己填金鑰存在裝置上 ——
> **絕對不能把開發者自己的金鑰打包進 App**，會被挖出來盜用。

### 第三階段：只有你做得到 / 對外才需要

**3-a. 拿真金鑰把 Azure 那條路跑完（唯一沒被實際驗證的一段）**

`server/azure-pronunciation.js` 的**實際呼叫從來沒成功跑過** —— 開發容器的 egress
擋掉 `*.stt.speech.microsoft.com` 與 `*.api.cognitive.microsoft.com`（CONNECT 回 403），
連認證失敗的路徑都測不到。

已驗證的是：SDK 參數形狀（對照型別定義）、結果解析（用真實 Azure JSON 的 `NBest[0]`
結構跑真正的 `PronunciationAssessmentResult`）、前端渲染（mock 回應）。
**使用者說在他本機測過可以動，但這裡沒有證據，不要假設它一定沒問題。**
`npm run test:e2e` 的【3】【5】就是為它寫的，有金鑰時在本機跑。

**3-b. 內容量** —— 聽力 81 組 / 226 題、對話 61 段，照每天練的量兩三週就會開始重複
（單字 10,040、跟讀 2,041 撐得久）。要補的話一定要跑過
`scripts/generate-content.mjs` 的驗證，別手寫繞過去。

**3-c. 公開部署的門禁** —— 沒帳號密碼、沒 rate limit。後端拿著兩組金鑰，
公開網址等於任何人都能一直送錄音上來燒配額；而且 `/api/settings` 會寫伺服器的
`.env`（見下面的雷）。只在 VPN／區網用就不急。

### 現在不建議做

- **打字輸入式** —— 選擇題已經涵蓋主動回想，打字多出來的只有拼寫，而要處理
  29% 同義撞號的成本不低。真想練拼寫再做中→英一個方向就好，`lib/grade.js` 可重用。
- **多答案選擇題** —— 同一個字的義項本來就很接近（說 / 講 / 念），會變成考中文語感。
- **帳號 + 雲端同步** —— 一個人用的話，1-a 的匯出／匯入解決 90% 的需求。

### 順手可以還的技術債

- **設定頁 10 個欄位擠在一起**，該分成「金鑰 / 單字卡 / 跟讀 / 語音 / 資料」幾張卡。
- **`filterBySettings` 的「情境＋難度」同時套在四個模式上**，但單字卡已經改用難度分級
  （`currentPool()` 對 ECDICT 的牌組刻意不套難度篩選）。設定頁應該講清楚它影響誰。
- **每日目標是一個數字，複習與新字共用**。到期的字超過每日目標時，那一天會全部
  拿去複習、抽不到新字（Anki 是拆成兩個上限）。字量還不大時碰不到，真的遇到再拆。
- **單字卡缺「哪些卡在哪個盒子」的完整清單**（`srsSummary()` 只給數量）。
  跟讀的紀錄檢視可以照抄形狀，見 `public/modes/shadowing-views.js`。
- **中文講評的開關只存在瀏覽器**（`geminiNarration`）。走 Docker 給家裡幾台裝置用的話，
  每台都要各自關一次。要的話可以加一個 `.env` 的預設值回在 `/api/health` 裡。
  **刻意沒先做**：一個人自己用設定一次就好，加了反而多一組要對齊的狀態。
- **`focus` 標籤與內容清洗都是啟發式的** —— 擋得掉「不完整」與「不像對話」，
  擋不掉「文法正確但沒人會這樣講」。要再往上就得有人看過，或用 AI 做一次**離線**的
  品質評分（一次性成本，不是執行期的）。

---

## 不要重踩的雷

每一項都是實際踩到並修好的。README 已經寫進設計理由的（16 kHz WAV、無人聲偵測、
SNI 不能放 IP、Freenom 已死…）這裡不重複，只列**改程式碼時會再踩一次**的。

### JavaScript 陷阱

- **`??` 不會對空字串 fallback。** 曾經寫成 `(wantVoice && find(...)) ?? fallback`，
  而 `wantVoice` 預設是空字串，`&&` 短路回傳 `''`，`??` 不接手，`voice` 變成字串而不是
  voice 物件，**所有模式都發不出聲音**。已改成三元運算子。
- **`h()` 的 children 要深層攤平**（`flat(Infinity)`）。`map()` 回傳巢狀陣列時只攤一層，
  內層會被印成 `[object HTMLSpanElement]`。
- **`el.append()` 不會過濾 `false`，`h()` 會。** 用 `cond && h(...)` 這種寫法時，
  條件不成立會把字串 `"false"` 印在畫面上（翻譯模式真的出現過）。
  一律用 `lib/dom.js` 的 `append()`，不要用原生的。
- **`e.currentTarget` 在非同步 callback 裡是 `null`。** 要在同步階段先把元素抓下來。
- **`speechSynthesis.getVoices()` 首次常回空陣列。** `lib/tts.js` 已用
  `voiceschanged` + polling 處理。
- **`window.speechSynthesis` 在 Chromium 是唯讀屬性**，測試 stub 直接指派會被無聲忽略，
  要用 `Object.defineProperty`。

### CSS

- **`[hidden] { display: none !important; }` 這條不能刪。** 整合時用腳本抽 CSS 區塊，
  腳本只留類別選擇器 → 這條屬性選擇器被丟掉 → `.waveform { display: block }` 直接蓋掉
  `hidden`，波形圖在不該出現的時候出現。CSS 檔裡有註解記著這件事。

### 每日進度

- **`vocabDays` 是計數表，不是紀錄清單。** 一天一個鍵、值是數字（`{'2026-09-05': 23}`），
  所以整年也才幾 KB。要改成「哪一天練了哪些字」之前先想清楚：一天 20 筆、一年 7,000 筆，
  而畫面上只需要一個數字。
- **不要想從 `srs` 算今天練了幾張。** srs 每張卡只留最後一次的狀態，答過就被蓋掉。
- **`unit` 與 `label` 是兩個參數**（`today-card.js`）。中文湊不出來：
  `'今天練的' + '個字'` 會變成「今天練的個字」。重構那張卡的時候真的踩過。
- **連續天數只有一份算法**（`practice.js` 的 `streakFromDays()`）。跨月、跨年、
  日光節約的邊界都在那裡處理過了，不要在單字卡那邊另外寫一個。

### 選擇題

- **題型與干擾項要在「換卡」的時候決定一次並存起來**（`prepareCard()`）。
  放在 `render()` 裡的話，每次重畫（選了選項、按了播放）都會重抽，選項會在眼前跳掉。
- **中→英不可以在作答前給發音鍵** —— 唸出來就等於直接給答案。英→中沒這個問題
  （題目本來就是那個英文字）。
- **`Math.max(NaN, 0)` 還是 `NaN`**，夾範圍夾不掉壞掉的亂數。`pickType()` 少了
  `Number.isFinite()` 那道檢查就會回 `undefined`，畫面變成一張空白的卡。測試抓到過。
- **`test/ui.mjs` 的 `seed()` 要把 `vocabDays` 也清掉。** 選擇題那一段接在
  「每日目標」後面跑，今天的份已經被上一段用掉 3 張，counter 就變成 1 / 17
  而不是 1 / 20 —— 症狀看起來像選擇題的 bug，其實是測試之間互相汙染。

### 前端測試的選擇器很脆

- **`test/ui.mjs` 的設定頁測試用 `.chips` 的順序抓元素**（`.first()` 是情境、
  `.nth(1)` 是難度）。在它們前面插入新的 chips 群組會讓那兩條測試抓錯東西 ——
  加在後面。中文講評的開關與每日單字數就是因此放在難度後面，不是放在最上面。
  （後來加的兩組都用 `.field` + `hasText` 抓，不吃順序，比較穩。）
- **跟讀畫面只有一個 `.check`**，而 `setRecordingUI()` 與 `ui.mjs` 都用
  `querySelector('.check input')` 抓那個唯一的 checkbox。要在跟讀畫面再加一個
  checkbox 的話，這兩處都要跟著改成 `querySelectorAll` 或更精確的選擇器
  （中文講評的開關放在設定頁、而且用 chips，就是為了不去動這個接縫）。

### 前端狀態

- **`setRecordingUI()` 刻意不重新 render**，所以它要**直接改 DOM** 上的 `disabled`。
  漏掉的那幾個（換一句、加權開關、每日目標）在錄音中還是點得下去。
- **波形圖的 canvas 會在 re-render 後變成孤兒。** `shadowing.js` 追蹤
  `waveformCanvas`，canvas 換掉時要重建 —— 不然畫進一個已經不在畫面上的元素，
  症狀是「波形不動」而不是報錯。
- **`Recorder.stop()` 要把 `blobToWav()` 算好的 `stats` 往外傳。** 少了它，
  「這段錄音幾乎沒有聲音」的即時提示就做不到，使用者要等送出後才被後端擋下來。

### 資料與 API

- **SRS 的鍵用牌組的 `keyspace`，不是牌組 id。** 精選的 id 與 ECDICT 的字會撞
  （都從 1 起算），所以要分開；但難度分級與詞頻級距是**同一批字的兩種切法**、id 相同，
  必須共用 `ecdict:`，否則同一個字有兩份進度。見 `lib/storage.js` 的 `srsKeyOf()`
  與 index.json 的 `keyspace` 欄位。
- **`migrateSrs()` 刻意不看版本號。** 用版本號當關卡的話，「版本已經是 2、
  但還有舊鍵留著」就永遠搬不動了 —— 而那個狀態做得出來（開發時手動塞舊資料就會遇到），
  症狀是**進度看起來歸零、沒有任何錯誤訊息**，很難聯想到是 migration 沒跑。
  現在每次載入都跑一遍、只在真的有東西要搬時才寫回去。
- **`build-vocabulary.mjs` 重跑之前先 `--out` 到暫存目錄比對 band 的 word 與 id。**
  那些 id 就是複習進度的鍵，字跑掉等於把進度洗掉。（2026-09 那次重跑比對過：
  既有欄位一個都沒變，只多了 `tier` / `collins` / `oxford`。）
- **`curated.json` 是手寫的，腳本不產生它。** 腳本原本 `rmSync` 整個
  `content/vocabulary/`，重跑一次就刪掉它；而且腳本寫的欄位叫 `bands`、
  App 讀的是 `decks`（committed 的 index.json 是後來手改的）。兩個都修了，
  `vocabulary.test.js` 各有一條釘住。**改建置腳本時記得它的輸出要餵得動 App。**
- **`server/gemini.js` 的 model 是白名單 + 陣列，不是單一常數。** 整合時
  `narrateAssessment()` 裡還留著舊的 `MODEL` 常數 —— 一設定 Azure 就會 ReferenceError，
  而那條路在容器裡測不到。動 model 相關的東西時把兩條路徑都掃過。
- **講評缺席有四種原因，訊息不能共用一句話。** `narrateAssessment()` 對「沒金鑰」
  與「呼叫失敗」都回 `null`，所以 `server/index.js` 要自己用 `hasApiKey()` 分開；
  再加上使用者自己關掉（`disabled`）與沒設 Azure 時關掉等於沒用（`gemini_scores`）。
  這四種在畫面上寫成同一句話的話，「你自己關的」會被當成「壞了」。
- **Gemini 對無效金鑰回的是 HTTP 400，不是 401/403**，SDK 訊息裡也看不到
  `API_KEY_INVALID`。所以 400 的錯誤訊息要同時提示金鑰與音檔兩種可能。
- **`/api/settings` 只接受 loopback 請求，而 loopback 檢查擋不住反向代理。**
  Caddy 的 `reverse_proxy localhost:3000` 在後端看起來就是本機請求。
  **公開部署前必須移除這兩個端點或加真正的認證。**
- **compose 的 `environment:` 要跟著程式碼一起加。** 容器裡沒有 `.env`，金鑰是
  compose 從主機的 `.env` 轉進去的。階段 11 接上 Azure 之後，`docker-compose.yml`
  只列了 Gemini 那兩個變數 —— 走 Docker 部署時 Azure 金鑰進不到容器裡，
  **容器照樣起得來、healthcheck 照樣過**，只有發音評估安靜地死掉。
  對照方式：`grep -rhoE "process\.env\.[A-Z_]+" server public | sort -u`。
- **DuckDNS 的權威 NS 不回應 TCP/53**，而 Caddy 預設會直接去問權威 NS 確認 TXT
  傳播 —— 檢查永遠做不完，就一直不通知 Let's Encrypt，卡在重試迴圈。
  `Caddyfile.duckdns` 用 `resolvers` + `propagation_timeout -1` +
  `propagation_delay 60s` 解掉。這類失敗在通知 LE 之前，不吃失敗驗證的額度。
- **匯入句子的 `QUOTA` 算的是「這個情境總共要幾句」。** 原本 `perCategory` 從 0 起算，
  句庫滿了再跑一次照樣加滿一輪（daily 278 → 528）。句子有去重所以不會出現重複句，
  症狀只是句庫悄悄膨脹到兩倍、沒有任何錯誤訊息。`sentences.test.js` 有一條釘住這件事。

### 內容

- **解析不能只是把英文原句抄一遍加中文句號。** 這是這個專案裡反覆犯的錯，三個聽力批次
  分別被驗證擋下 12、0、5 筆，全是同一個問題。`scripts/generate-content.mjs` 的驗證會擋，
  **新增內容一定要跑過那套驗證**（指令見 README「內容驗證」）。
- ECDICT 的原始資料很髒：釋義是簡體、音標混用非 IPA 字元（`ә` 是西里爾字母、
  `^` 其實是 `ɡ`、`\` 是 `ɜ`）。清理邏輯在 `scripts/build-vocabulary.mjs`，改之前先讀註解。
- **OpenCC 的簡繁一對多會轉錯。** 簡體「发」對應正體的「發」與「髮」，靠詞組判斷；
  詞組表沒收的組合（「被发明」）會轉成「被髮明」。`import-sentences.mjs` 有一張 `FIXES`
  替換表，`sentences.test.js` 會掃這些型樣。**注意「沒幹」是對的**（干 當動詞要轉成 幹），
  不要當成錯誤加進去。
- **關鍵字過濾是很鈍的工具。** `UNPLEASANT` 那張表擋的是「文法沒錯但不該拿來練」的句子
  （真的漏出去過一句 "An old woman was burnt to death."）。`afraid` 是刻意不放進去的 ——
  「I'm afraid I can't.」是很常用的句型。

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
- **`pkill -f "node server/index.js"` 會連自己的 shell 一起殺掉**（exit 144），
  改用 `ps -eo pid,args | awk ... | xargs kill`
- Playwright 的瀏覽器已預裝，用 `CHROMIUM=/opt/pw-browsers/chromium-*/chrome-linux/chrome`
  指過去，不要 `playwright install`
- 容器在整合期間重啟過數次，**分階段 commit**，不要累積一大批未提交的成果
