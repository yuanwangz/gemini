# 使用官方 Node.js 運行時作為基礎鏡像
FROM node:18-alpine AS base

# 設置工作目錄
WORKDIR /app

# 複製 package.json 和 package-lock.json
COPY package*.json ./

# 安裝依賴
RUN npm ci --only=production && npm cache clean --force

# 複製應用程序源代碼
COPY . .

# 創建非 root 用戶
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

# 更改文件所有權
RUN chown -R nextjs:nodejs /app
USER nextjs

# 暴露端口
EXPOSE 8080

# 設置環境變量
ENV NODE_ENV=production
ENV PORT=8080

# 健康檢查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http = require('http'); \
    const options = { hostname: 'localhost', port: process.env.PORT || 8080, path: '/v1/models', method: 'GET' }; \
    const req = http.request(options, (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }); \
    req.on('error', () => process.exit(1)); \
    req.end();"

# 啟動應用程序
CMD ["npm", "start"]
