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
| 🏠 今天 | 各模式今天的進度、連續天數、待複習數，點一下跳進去 | 完成 |
| 🗂️ 單字卡 | 10,040 字，**自己選難度**（6 級）＋各級進度＋**每日目標**＋**中英雙向選擇題**（答完會列出其他選項的意思與發音），Leitner 盒子制 | 完成 |
| ⌨️ 鍵盤 | 六個模式都能不摸滑鼠練完（提示在左側模式列） | 完成 |
| 📱 PWA | 加得到主畫面、斷線也打得開 | 完成 |
| 🎧 聽力 | 81 組 / 226 題＋每日進度（**照題組算，不是照題數**） | 完成 |
| ✍️ 中翻英 | **2,159 題**（填空 161 / 整句 1,998）＋每日進度 | 完成 |
| 💬 情境對話 | 61 段 / 427 句台詞＋每日進度 | 完成 |
| 🗣️ 跟讀 | 2,041 句 / 8 種情境，Azure 逐音素評分 + 間隔重複 + 弱點音加權 + 連續天數 | 完成 |
| ⚙️ 設定 | 金鑰、中文講評開關、model、練習範圍、語音、學習資料、**跨裝置同步** | 完成 |
| 🔐 帳號 | 全部 `/api` 都要登入；進度存在伺服器上（**手動**上傳／下載，自動合併是階段 B） | 階段 A 完成 |

驗證狀態：`npm test` 295 項全過、`npm run test:ui` 218 項全過、
`npm run test:layout` 是尺不是測試（見 README「版面盤點」）、
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

最新的一件：**帳號與跨裝置同步的階段 A 做完了**（設計在
`docs/accounts-and-sync.md`，那份文件仍然是階段 B 的規格）。

做完的是：Docker volume、帳號（scrypt + cookie session + CSRF + 登入退避）、
**全部 `/api` 端點都要登入**（只有 `/api/health` 與 `/api/auth/*` 例外）、
伺服器存檔（`GET`／`PUT /api/sync`，rev 樂觀鎖，保留最近 10 版）、
登入畫面、設定頁的「跨裝置同步」卡。**同步目前是手動的整包覆蓋**，
自動合併是階段 B。

順手做掉的兩件（為階段 B 鋪路，早加早有資料）：`srs` 每一筆多寫一個 `at`
（最後一次作答的時間 —— `due` 判斷不了新舊），`settings` 多一個 `updatedAt`。

三個實作時踩到、值得記住的（詳見下面的雷）：掛在 `/api` 的中介層裡
`req.path` 是相對路徑、`body.locked` 藏掉側欄之後 `.page` 會掉進 grid 的第一欄、
離線時不要去問 `/api/auth/me`。

再前一件：**講評可以換成任何 OpenAI 相容的模型**（同一個分支）。
理由是設定好 Azure 之後唯一有感的等待就是那一段，而它做的事很小
（吃一小段 JSON、吐四行中文），換個快的模型就會快很多。設計寫在 README
「換一個更快的講評模型」。

三個接手時要知道的位置：`server/narrator.js`（**選擇邏輯只有這一份** ——
`/api/health`、真的要呼叫、啟動訊息三個地方都問它，各判斷一次一定會有一天
對不起來）、`server/openai-narrator.js`（真正的 HTTP）、
`server/narration.js` 的 `buildNarrationPrompt()` 與 `cleanNarration()`
（prompt 兩條路共用，回來的純文字在這裡整理）。

**這條路跟 Azure 一樣，在容器裡驗不到真的呼叫**（egress 擋掉 HF／Groq／OpenAI）。
但整條路有真的跑過一次：用 loader 把 Azure 換成假的、`NARRATION_BASE_URL`
指到 loopback 上一個假的 OpenAI 端點 —— 走的是真的 fetch、真的 HTTP。
指令在 README 那一節。這招也抓到一個只有跑起來才看得到的 bug（見下面的雷）。

再前一件：**中翻英題庫從 279 題擴到 2,159 題**（分支
`claude/expand-question-bank-model-swap-84rc5q`）。用的是**同一批** Tatoeba 語料 ——
跟讀句庫只吃英文那一半，中文那一半在中翻英才派上用場，所以這件事離線就做得完、
不用金鑰。設計寫在 README「中翻英題目：同一批語料的另一半」。

重點不是題數，是 **`accept[]`**：同一句中文在語料裡常常對到好幾句英文，
那些是真人寫的對等翻譯，整組收下去，使用者寫出任何一種都算完全正確。
`keywords` 也改成「每一個 accept 都出現的實詞」的交集 —— 不然畫面上明明把某個說法
列在「其他說法」裡，照著寫的變化型卻拿到 ❌。

順手做掉的：兩支匯入腳本的語料清洗抽成 `scripts/corpus.js`（唯一一份），
中翻英答完之後「其他說法」全部列出來（本來只列第一個），
`explain_zh` 變成選填（匯入的題目沒有，硬湊一句沒內容的說明不如把版面讓給說法）。

再前一件：**第二階段（日常手感）做完了** —— 鍵盤操作、釋義截斷、PWA。
設計都寫在 README（「鍵盤操作」、「🗂️ 單字卡」的釋義那段、「加到主畫面（PWA）」），
這裡只記三個接手時會用到的位置：`public/lib/keys.js`（擋掉打字中／組字中／
按鈕上的鍵是它的重點）、`public/sw.js` 的 `strategyFor()`（哪個網址走哪條規則的
唯一出處）、`scripts/build-icons.mjs`（圖示是產物但**要 commit**）。

再前一件：**版面改版**（三個 commit）。桌機上原本只用掉 47% 的寬度、
所有東西擠在同一欄，現在是「左側模式列 ｜ 練習區主欄 ｜ 輔助欄」三區，
手機是「練習區 + 下方六格模式列」。設計與各斷點寫在 README「版面：模式列 ｜
練習區 ｜ 輔助欄」。分欄的規則在 `public/lib/layout.js`（`columns` / `single` /
`grid` 三個函式），模式模組不知道自己被排在哪裡。要量效果用新的
`npm run test:layout`。

前一件：**選擇題答完之後，另外三個選項也會給字、音標、詞性、簡短釋義與發音鍵**
（自己選錯的那一個標成「你選的」）。理由是一題看四個字、原本只有答案那個留得下東西，
而干擾項本來就是同一級的字。實作上只動兩個地方：`lib/quiz.js` 的選項多帶四個欄位
（出題時就抓好，畫面不回頭查字庫）、`modes/vocabulary.js` 多一段 `otherOptions()`。
釋義用新的 `briefMeaning()` 截到 3 個義項 —— 這也是待辦 2-b 的一半，
另一半（卡片背面那一整坨 `meaning_zh`）還沒動。

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
| `public/lib/layout.js` | 練習區怎麼分欄。**改任何模式的版面都從這裡開始**：主欄放「現在要動手的那一件事」，其餘進輔助欄。`side` 的 DOM 順序就是手機上的顯示順序 |
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

**1-a. 學習資料的匯出／匯入** ✅ **做完了**（設定 → 學習資料）

規則與踩到的坑寫在 README「備份與還原」。一句話版本：是覆蓋不是合併、
覆蓋前會講清楚用什麼覆蓋、壞檔案一律擋下且不動現有資料、`BACKUP_KEYS` 同時是白名單。
**新增要備份的資料時記得把鍵加進 `BACKUP_KEYS`** —— 漏加的症狀是
「還原之後某一種進度不見了」，而且不會有任何錯誤訊息。

**1-b. 進度系統推到聽力、中翻英、情境對話** ✅ **做完了**

六個模式現在共用一張計數表（`activity`）與一套每日進度（`lib/daily.js`）。
設計與「什麼動作算一次」寫在 README「每日進度與連續天數」。
順手做掉的：`app.js` 裡寫死的標籤／圖示／副標題收進 `lib/modes.js`（首頁也要用），
每日目標從兩個分散的設定併成一個 `dailyGoals`，並刪掉三個已經沒有呼叫者的
`practice.js` 函式（`todayCount` / `streakDays` / `practiceDays`）——
它們的邊界測試轉到真正在跑的 `streakFromDays`。

**1-c. 「今天」首頁** ✅ **做完了**

`public/modes/home.js`。設計決定寫在 README「🏠 今天」——
連續天數是「任何一個模式有練就算」（不是取最大值），待複習直接數 `srs` 裡到期的
筆數（不載入 3 MB 的字庫）。首頁也是 App 打開時的預設落點。

**第一階段做完了。**

### 第二階段：日常手感 ✅ **做完了**

**2-a. 鍵盤操作** ✅ 六個模式都能用鍵盤練，側欄常駐提示有哪些鍵。
共用層在 `lib/keys.js`，規則與各模式的鍵在 README「鍵盤操作」。
**加或改快捷鍵時，`lib/modes.js` 的 `keys`（提示文字）與模式的 `onKey()`（實作）
要一起改** —— 不同步的症狀是「畫面上寫的鍵按了沒反應」。

**2-b. 釋義截斷** ✅ 卡片背面先給前 4 個義項，多的收在「看全部」後面
（義項 > 4 **且** 字數 > 40 才截，理由在 README）。答完之後那三個干擾項的釋義
用的是 `lib/quiz.js` 的 `briefMeaning()`（3 個義項），兩個地方的門檻**刻意不同**：
干擾項只是順便瞄一眼，背面是要看完整的。

**2-c. 手機（PWA）** ✅ manifest + 圖示 + service worker 都有了，
斷線重新整理也打得開（`test/ui.mjs`【19】真的把網路關掉試一次）。
**加新的前端檔案時要加進 `sw.js` 的 `SHELL`** —— `test/pwa.test.js` 會掃過
`public/` 比對，漏了就紅（症狀本來是「離線時某個模式打不開」，有網路完全看不出來）。

> **金鑰放哪裡**：現在在伺服器的 `.env`。走 Docker 就沿用這個，不用改。
> 真的要做成獨立 App 的話，讓使用者自己填金鑰存在裝置上 ——
> **絕對不能把開發者自己的金鑰打包進 App**，會被挖出來盜用。

> **手機上要裝得起來必須是 HTTPS**（service worker 跟麥克風一樣要 secure context，
> 區網 IP 不算）。走 `docker-compose` + Caddy 的話已經有了。

### 第三階段：只有你做得到 / 對外才需要

**3-a. 拿真金鑰把 Azure 那條路跑完（唯一沒被實際驗證的一段）**

`server/azure-pronunciation.js` 的**實際呼叫從來沒成功跑過** —— 開發容器的 egress
擋掉 `*.stt.speech.microsoft.com` 與 `*.api.cognitive.microsoft.com`（CONNECT 回 403），
連認證失敗的路徑都測不到。

已驗證的是：SDK 參數形狀（對照型別定義）、結果解析（用真實 Azure JSON 的 `NBest[0]`
結構跑真正的 `PronunciationAssessmentResult`）、前端渲染（mock 回應）。
**使用者說在他本機測過可以動，但這裡沒有證據，不要假設它一定沒問題。**
`npm run test:e2e` 的【3】【5】就是為它寫的，有金鑰時在本機跑。

**3-b. 內容量** —— 中翻英做完了（279 → 2,159 題），**聽力 81 組 / 226 題、
對話 61 段還沒動**，照每天練的量兩三週就會開始重複（單字 10,040、跟讀 2,041 撐得久）。

中翻英能離線補是因為 Tatoeba 給的本來就是中英句對，剛好就是這個模式要的東西；
聽力要逐字稿、對話要整段對白，語料裡沒有，只能用 `scripts/generate-content.mjs`
生成 —— **那需要 `GEMINI_API_KEY`，而開發容器裡沒有金鑰**，所以這兩個只能在本機跑：

```bash
node scripts/generate-content.mjs listening --count 20
node scripts/generate-content.mjs dialogue  --count 10 --category work
```

一定要跑過那支腳本的驗證，別手寫繞過去（見下面「內容」那一段的雷）。

**3-c. 公開部署的門禁** —— 沒帳號密碼、沒 rate limit。後端拿著兩組金鑰，
公開網址等於任何人都能一直送錄音上來燒配額。只在 VPN／區網用就不急。

**設計已經定案，寫在 `docs/accounts-and-sync.md`** —— 跟「跨裝置同步」合併成
同一件事做（帳號本來就是門禁）。分兩階段：A 帳號 + 門禁 + 伺服器存檔（可單獨上線），
B 自動合併同步。**階段 A 的第一件事是給 `app` 掛 Docker volume** ——
現在沒掛，容器一重建使用者的全部進度就消失，而且沒有任何錯誤訊息。

一個對下面那條雷的更正：`/api/settings` **已經是安全的**。`assertLocalRequest()`
只放行 127.0.0.1，而在 Caddy 後面所有請求的來源都是代理的容器 IP，
包含攻擊者的。真正沒有把關的是 `/api/pronunciation-feedback`。

### 現在不建議做

- **打字輸入式** —— 選擇題已經涵蓋主動回想，打字多出來的只有拼寫，而要處理
  29% 同義撞號的成本不低。真想練拼寫再做中→英一個方向就好，`lib/grade.js` 可重用。
- **多答案選擇題** —— 同一個字的義項本來就很接近（說 / 講 / 念），會變成考中文語感。
- ~~**帳號 + 雲端同步**~~ —— **這條改主意了**，設計在 `docs/accounts-and-sync.md`。
  原本的理由是「一個人用的話，1-a 的匯出／匯入解決 90% 的需求」，
  而那個前提在有了網域 + 手機安裝之後不成立：匯出／匯入是**覆蓋不是合併**，
  天天在兩台裝置之間手動搬，遲早有一次拿舊的蓋掉新的、而且沒有錯誤訊息。
  更關鍵的是**帳號跟下面 3-c 的門禁是同一件事**，一起做只做一次。

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
- **手寫的 118 題中翻英，keywords penalise 自己列出來的「其他說法」**。
  118 題裡有 93 題的 keywords 是照 `answer` 挑的，而 `accept[1]` 常常是很不一樣的
  講法（「That works for me.」／「That's fine with me.」）。照著 `accept[1]`
  一字不差地寫沒問題（`grade()` 先比對完全相符），但寫成它的變化型就會被判
  「再想想」。匯入的 1,880 題沒有這個問題（`keywordsFor()` 用交集算，
  `test/translation.test.js` 釘住）。要修的話跑：
  ```bash
  node --input-type=module -e "
  import {tokens} from './public/lib/grade.js';
  import {readFileSync} from 'node:fs';
  const d=JSON.parse(readFileSync('content/translation.json','utf8'));
  for(const x of d.filter(y=>!y.source&&y.keywords))
    for(const a of x.accept){const g=new Set(tokens(a));
      const m=x.keywords.filter(k=>!tokens(k).every(t=>g.has(t)));
      if(m.length)console.log(x.id,m.join(','),'|',a);}"
  ```
  **刻意沒自動修**：那些 keywords 是照教學意圖挑的（「walk me through」、
  「round-trip」），用交集重算會把它們換成 try / things 這種沒有教學價值的字。
  真要修得一題一題看。

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

### 首頁

- **模式模組不可以 import `app.js`** —— 它們是被 `app.js` 動態 import 的，
  反過來會變成循環相依。要切模式就發 `switch-mode` 事件。
- **首頁不載入任何字庫檔**。待複習的數字是直接數 `srs` 裡到期的筆數，
  為了一個數字把 3 MB 抓下來太蠢；同理各模式的進度只讀計數表。

### 每日進度是六個模式共用的

- **`activity` 找不到時會從舊資料生一份**（`buildActivity()`）。所以測試要模擬
  「還沒有計數表」的情況得**把那個鍵刪掉**，不是寫成 `{}` —— 寫成空物件的話
  migration 不會跑，跟讀的今天進度就會是 0。
- **清成績與清「有沒有回來練」是兩件事**：`resetSrs()` 與 `clearHistory()` 都
  不動計數表，要清連續天數得用設定頁的「清除每日紀錄」（`clearActivity()`）。
- **聽力的「再做一次」跟中翻英的「再試一次」是同一個坑。** 兩個都會把
  `submitted` / `checked` 清掉，所以**不能拿它們判斷有沒有算過** ——
  要另外一個跟著題目（題組）走的 `counted` 旗標。聽力原本就是這樣壞的：
  同一組重做會再記一次。
- **改一個模式的計數單位，要同時改四個地方**：模式的 `recordPractice()`、
  `lib/modes.js` 的 `unit` / `todayLabel`、`settings.js` 的 `DEFAULTS.dailyGoals`
  與 `migrate()`、以及設定頁的 `GOAL_CHOICES`。漏掉 `migrate()` 的症狀最糟 ——
  使用者設過的目標數字意思悄悄變了，目標從此達不到，而畫面上沒有任何徵兆。
  `test/ui.mjs` 裡寫死的 activity 假資料也要跟著改單位（首頁那個「聽力一半」
  的 fixture 就是因此變成「已達標」，害另一條測試紅掉）。
- **「一次算什麼」每個模式不一樣**，而且都有理由（見 README 的表）。
  中翻英要注意「再試一次」會把 `checked` 清成 null，所以不能拿它判斷有沒有算過，
  要另外一個跟著題目走的旗標。

### 備份

- **`BACKUP_KEYS` 漏加一個鍵 = 那種進度還原不回來**，而且完全沒有錯誤訊息。
  加新的 localStorage 資料時，第一件事是問「這個要不要進備份」。
- **`download` 屬性用中文檔名會被 Chromium 整個忽略**，檔案存成沒有副檔名的
  `download`。檔名一律 ASCII。
- **還原之後要 `location.reload()`**，不能只是重畫：設定（`lib/settings.js` 的 `cache`）
  與複習進度都有模組層級的快取，不重載就會有模組還拿著舊資料。
- **選檔案的 `<input type=file>` 用完要把 `value` 清掉**，不然選同一個檔案第二次
  不會觸發 `change`（還原失敗想重試同一個檔就會像沒反應）。

### 版面

- **`.view--split` 要寫成 `#view.view--split`。** id 的優先度比 class 高 ——
  寫成 class 的話 `display: grid` 被 `#view { display: flex }` 蓋掉，而同一條規則裡的
  `align-items: start` 照樣生效，症狀是兩欄變成擠在左邊的一列、寬度縮成內容的大小。
- **輔助欄的 DOM 順序就是手機上的順序**（窄螢幕上 `side` 接在 `main` 後面）。
  「這一頁的標題數字」放輔助欄的話，手機上會掉到清單下面才看得到 ——
  首頁的總覽卡就是因此搬回主欄最上面的。
- **切回單欄一定要走 `single()`／`grid()`**，不能只是 `clear(root)`。`.view--split`
  留在 `#view` 上的話，下一個畫面只會用到左邊那一欄，右邊空著一大塊。
- **中文按鈕要 `white-space: nowrap`。** 中文沒有空白可以斷，瀏覽器會斷在字與字
  之間（「換難 度」），390px 下真的會發生。要換行的是外面的 `.row`，不是按鈕自己。
- **模式模組的 `root.querySelector()` 都是後代選擇器**，所以多包一層 `.view__main`
  不影響（`setRecordingUI()` 那幾個直接改 DOM 的也是）。要在模式裡用
  `root.children` 或 `:scope >` 之類的寫法之前先想到這件事。
- **版面改壞了不會有任何測試變紅。** `npm run test:ui` 驗的是「按下去有沒有反應」，
  不是「看起來對不對」。動版面的時候用 `npm run test:layout` 前後各跑一次，
  再存截圖看過 —— 這是唯一會告訴你「這一頁變成要捲三個螢幕」的東西。

### 鍵盤

- **快捷鍵最容易壞的地方不是快捷鍵本身，是「什麼時候不該接」。** `lib/keys.js`
  擋掉四種：正在打字、中文輸入法組字中（`isComposing`）、焦點在按鈕上的
  Enter／空白（瀏覽器本來就會觸發，再接一次等於按兩下）、以及有按修飾鍵。
  **加新的快捷鍵不要自己 `addEventListener`**，走 `bindKeys()`。
- **`onKey()` 回 `true` 才會 `preventDefault()`。** 沒接到的鍵要留給瀏覽器 ——
  一律 preventDefault 的話空白鍵就不能捲頁面了。
- **提示與實作是兩個檔案**（`lib/modes.js` 的 `keys` ／ 各模式的 `onKey()`），
  改一邊忘了另一邊的症狀是「畫面上寫的鍵按了沒反應」。
- **要能用鍵盤呼叫的動作，函式不能非有按鈕不可。** `playWord()` 與 `playDemo()`
  原本都是 `e.currentTarget` 拿按鈕來改字，鍵盤按 S / P 時沒有按鈕，
  兩支都改成按鈕可以是 null。

### 帳號與同步

- **掛在 `/api` 上的中介層裡，`req.path` 是相對路徑。** express 會把掛載路徑
  剝掉，所以 `/api/health` 進到關卡時 `req.path` 是 `/health` ——
  拿它去比對免登入清單就會把 healthcheck 也擋掉。症狀是容器一直 unhealthy、
  或啟動腳本的「等 `/api/health`」永遠等不到（**真的踩過**，而且第一眼看起來
  像伺服器沒起來）。要用 `req.baseUrl + req.path`。
- **`Secure` cookie 要看請求決定，不能寫死。** 本機開發是 `http://localhost`，
  帶了 `Secure` 的 cookie 在 http 上根本不會被存起來，而症狀是
  「按了登入沒反應」，console 也不會有東西。
- **離線時不要去問 `/api/auth/me`。** 那個請求一定失敗，而失敗的資源請求會在
  console 留下一筆紅色錯誤 —— `test/ui.mjs`【20】會抓到。離線本來就該直接進 App
  （題庫在快取裡、進度在 localStorage 裡）。用 `navigator.onLine === false` 判斷。
- **`body.locked` 把側欄藏起來之後，shell 的分欄也要關掉。** 桌機上 `.shell` 是
  `grid-template-columns: var(--rail-w) minmax(0,1fr)`，而 `display:none` 的 `.rail`
  會被移出 grid 流 —— `.page` 於是掉進**第一欄**（側欄那格），登入卡被擠成
  230px 寬的一條。實測踩到，`test/ui.mjs`【21】有一條釘住。
- **切到登入畫面要走 `single(view)`，不是 `clear(view)`。** 跟版面那一段是同一條雷：
  `#view` 上留著上一個畫面的分欄類別的話，登入卡只會用到左邊那一欄。
- **登入表單重畫時欄位的值要自己留著。** 每次 `draw()` 都是整個重建 DOM ——
  不留的話密碼打錯一次就得連帳號一起重打。
- **`test/ui.mjs` 需要一個乾淨的 `DATA_DIR`**（`DATA_DIR=$(mktemp -d) npm start`）。
  測試會建一個 `uitest` 帳號，而「第一個帳號」才建得起來。
  裡面打 API 一律走 `apiGet()` —— 漏帶 cookie 的話拿到的是 401 的 JSON 物件而不是
  陣列，症狀是「`.find` is not a function」，完全看不出原因（踩過）。
- **`sessions.json` 裡不可以出現明文 token。** 只存 SHA-256，
  `auth.test.js` 有一條真的去搜檔案內容。
- **壞掉的資料檔不可以被當成「空的」往下走** —— 那等於把使用者的進度靜靜清空。
  寧可整個請求失敗，至少人看得到、也知道去翻 `u/<id>.rev-N.json`。
- **`DATA_DIR` 沒掛 volume ＝ 進度全沒**，而且症狀是「重新部署之後從頭開始」，
  沒有任何錯誤訊息。`chown` 漏了則是容器起得來、healthcheck 也過，
  只有第一次寫進度時才 EACCES。
  **這兩個在這個容器裡驗不到**（有 docker CLI 但沒有 daemon）——
  驗過的是「同一個 `DATA_DIR` 重啟之後帳號、session 與進度都還在」。

### PWA

- **Android 上「已封鎖不安全的應用程式 / 這個應用程式是專為舊版 Android 打造」
  不是這個 App 的問題，也不是 Play 防護擋來源不明。** 那是 Android 14+ 對
  `targetSdkVersion < 34` 的封鎖，而 WebAPK 的 targetSdk 是**瀏覽器的產生伺服器**
  決定的，manifest 影響不到。Samsung Internet 到 2026-09 還在產低於 34 的包
  （[SamsungInternet/support#123](https://github.com/SamsungInternet/support/issues/123)，
  還開著），Chrome 產的是 ≥ 34 —— **同一個網址用 Chrome 裝就過**。
  不要為了這個去改 manifest，改不動。
- **要判斷「是不是 App 這一側的問題」，直接問 Chrome，不要自己重寫一份判斷規則。**
  `npm run test:ui`【19】最後三條用 CDP 的 `Page.getInstallabilityErrors` /
  `Page.getAppManifest` + `beforeinstallprompt`。自己照文件重寫一份的話一定會跟
  Chrome 的實作分岔，而分岔的方向永遠是「測試說可以、實際裝不起來」。
- **那三條一定要用 `launchPersistentContext`。** 一般的 Playwright context 是
  無痕模式，Chrome 在無痕下一律回 `in-incognito`，那一條會蓋掉所有其他原因 ——
  看起來像「有一個阻礙」，其實是測試自己造成的。
- **新增 `public/` 底下的 .js / .css 要加進 `sw.js` 的 `SHELL`。** 漏掉的症狀是
  「離線時某個模式打不開」，而有網路的時候完全看不出來。`test/pwa.test.js`
  會掃過目錄比對，所以漏了會紅 —— 那條測試存在的唯一理由就是這個。
- **service worker 用 stale-while-revalidate，不要改成 cache-first + 版本號。**
  忘了改版本號的話使用者會永遠停在舊版，重新整理也一樣（快取先回答了），
  而且沒有任何徵兆。
- **`/api/settings` 與 `/api/pronunciation-feedback` 不可以進快取**：一個是金鑰，
  一個是每次都不一樣的評分結果。`strategyFor()` 是唯一決定這件事的地方。
- **圖示是產物但要 commit。** 使用者不會先跑 `scripts/build-icons.mjs`，
  而 manifest 指到不存在的圖示時瀏覽器不會報錯，只是圖示變成一個灰方塊。
- **`test/ui.mjs` 不再濾掉 404**（以前是為了沒有 favicon）。現在 404 一律是真問題。

### 選擇題

- **選項要自己帶著資料，不要在畫面上回頭查字庫。** 答完之後列出的另外三個字
  （字／音標／詞性／釋義）是 `buildQuestion()` 的 `toOption()` 一起抓好的。
  在 `render()` 裡用 `pool.find()` 反查的話，等於每次重畫都掃一遍 1,300～2,100 個字，
  而且 `question` 就不再是「那一題的全部資料」了。
- **發音鍵在作答前後是兩件事。** 答完之後每個選項都給 🔊 沒問題；作答前給就是洩題
  （中→英 的選項本身是答案）。`ui.mjs` 有兩條分別釘住這兩邊。
- **選項的 🔊 只寫一個 emoji，不寫「🔊 唸這個字」。** `ui.mjs` 的
  「中→英：作答前沒有發音鍵」那條是用畫面文字裡「唸這個字」出現的位置判斷的，
  一頁多三顆同樣文字的按鈕會讓那條測試失去意義（而且畫面上也太吵）。
- **題型與干擾項要在「換卡」的時候決定一次並存起來**（`prepareCard()`）。
  放在 `render()` 裡的話，每次重畫（選了選項、按了播放）都會重抽，選項會在眼前跳掉。
- **中→英不可以在作答前給發音鍵** —— 唸出來就等於直接給答案。英→中沒這個問題
  （題目本來就是那個英文字）。
- **`Math.max(NaN, 0)` 還是 `NaN`**，夾範圍夾不掉壞掉的亂數。`pickType()` 少了
  `Number.isFinite()` 那道檢查就會回 `undefined`，畫面變成一張空白的卡。測試抓到過。
- **`test/ui.mjs` 的 `seed()` 要把 `vocabDays` 也清掉。** 選擇題那一段接在
  「每日目標」後面跑，今天的份已經被上一段用掉 3 張，counter 就變成 1 / 17
  而不是 1 / 20 —— 症狀看起來像選擇題的 bug，其實是測試之間互相汙染。

### 本機全過 ≠ CI 會過

- **本機的 Chromium 跟 CI 不是同一版。** 這個容器裡預裝的是 `chromium-1194`，
  而 `@playwright/test` 1.62 要的是 `chromium-1234`（`npx playwright install`
  在這裡下載不到，egress 擋掉 CDN）。CI 用的是對的那一版，所以
  **「本機 npm run test:ui 全過」不代表 CI 會綠** —— 已經因此連紅兩次而沒發現。
  **push 之後一定要回頭看 CI**，不要只看本機。
- **`navigator.onLine` 不可靠。** 它在某些 Chromium 版本下不會跟著離線變成
  `false`（CI 的版本就是），所以拿它當「要不要發請求」的**唯一防線**會安靜地失效。
  它只能拿來省事，真正的防護要放在別的地方（`/api/auth/me` 是靠 `sw.js` 的
  `auth-probe` 把連不上換成 503）。
  重現方式：`p.addInitScript(() => Object.defineProperty(navigator, 'onLine',
  { get: () => true }))` 再 `ctx.setOffline(true)`，就跟 CI 的行為一樣。
- **不要驗 `beforeinstallprompt` 有沒有發。** 那個事件除了「符合安裝條件」之外
  還要看 Chrome 的使用者互動熱度與版本，CI 上不會發 —— 本機全過、CI 紅，
  而 App 本身完全沒問題。`Page.getInstallabilityErrors` 給的是同一件事而且是確定的。

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
- **`server/index.js` 裡有一個叫 `narrate` 的區域變數**（「使用者要不要講評」的布林值）。
  從 `narrator.js` import 進來的函式如果也叫 `narrate`，handler 裡的 `const`
  會把它遮掉，而錯誤是執行期的 `narrate is not a function` —— 單元測試抓不到
  （測不進 index.js），只有真的送一次錄音才會出現。所以那個 import 改名成
  `generateNarration`。**真的踩過**，就是在 loopback 假端點那次跑出來的。
- **講評的訊息不可以寫死廠商名。** 講評走哪一條路由 `NARRATION_PROVIDER` 決定，
  可以是 Gemini、也可以是任何 OpenAI 相容端點。寫死的話換過去之後，
  訊息會叫使用者去看一個根本沒在用的服務（「請設定 GEMINI_API_KEY」）。
  `narration.test.js` 有一條掃過三種缺席說明擋這件事。實際要顯示的名字由
  回應的 `narrationLabel` 帶上來，前端不自己猜（它看不到 `.env`）。
- **`cleanNarration()` 先拿掉符號、確認有字，才補上「• 」。** 順序反過來的話，
  只有一個符號的那一行會變成一個空的「• 」留在畫面上。測試抓到過。
- **超時要用 `AbortController`，不要用 `Promise.race`。** race 輸掉的那個請求
  還是掛在背景跑完才放掉連線，連續超時幾次就會累積一堆沒人要的請求。
  （Gemini 那條路還是 `Promise.race`，因為它走的是 SDK 不是 fetch。）
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

- **算 keywords 一定要用 `grade.js` 的 `tokens()`，不能用 `corpus.js` 的 `lower()`。**
  兩邊對連字號的處理不一樣：`lower()` 把 `ten-minute` 拆成 ten / minute，
  真正批改的 `tokens()` 留成一個。用 `lower()` 算出來的 keyword「ten」
  **永遠比對不到**，那一題就再也判不出「意思對了」，而畫面上只會說
  「少了這些關鍵用字：ten」，看起來像使用者漏字。匯入時中了 19 題，
  `test/translation.test.js` 的「每一個 keyword 都出現在 answer 裡」會抓。
- **`accept` 裡的每一種說法都必須自己過得了 `grade()`。** 它們會列在畫面上的
  「其他說法」裡 —— 使用者照著寫卻拿到 ❌ 是最傷的一種 bug，而且沒有任何錯誤訊息。
  加題目（手寫或匯入）之後跑 `node --test test/translation.test.js`。
- **`content/translation.json` 是 854 KB**（gzip 後 155 KB）。Caddy 有
  `encode zstd gzip` 所以走 Docker 沒問題，但**後端自己沒有壓縮中介層** ——
  要把它擺在別的反向代理後面時記得確認那一層有開壓縮。
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
| （其餘見下） | `huggingface.co` / `router.huggingface.co` |
| | `api.groq.com` / `api.openai.com` |
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
