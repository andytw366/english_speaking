# 練習 App 的容器。只裝正式相依套件 —— devDependencies 裡的 Tatoeba 語料有 7 MB，
# 那是匯入句子時才用得到的（`npm run sentences:import`），執行期完全不需要。

FROM node:22-alpine

WORKDIR /app

# 先只複製 lockfile 再安裝，這樣改程式碼不會讓相依套件那層失效
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY content ./content

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# 容器裡沒有 .env（dotenv 找不到檔案不會報錯），金鑰用環境變數傳進來
USER node

# 健康檢查用 /api/health —— 它不需要金鑰也回得了，正好拿來判斷「伺服器活著」
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server/index.js"]
