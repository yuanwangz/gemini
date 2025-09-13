# Docker 部署指南

本文件包含了使用 Docker 部署 Gemini OpenAI 代理服務的完整指南。

## 文件說明

- `Dockerfile` - 用於構建應用程序的 Docker 鏡像
- `docker-compose.yml` - 用於本地開發和部署的 Docker Compose 配置
- `.dockerignore` - 指定構建時要忽略的文件和目錄
- `.github/workflows/docker-build.yml` - GitHub Actions 自動構建和推送鏡像的工作流程

## 快速開始

### 1. 本地構建和運行

```bash
# 構建鏡像
docker build -t gemini-openai-proxy .

# 運行容器
docker run -d \
  --name gemini-proxy \
  -p 8080:8080 \
  -e GEMINI_API_KEY=your_api_key_here \
  gemini-openai-proxy
```

### 2. 使用 Docker Compose

```bash
# 啟動服務
docker-compose up -d

# 查看日誌
docker-compose logs -f

# 停止服務
docker-compose down
```

### 3. 環境變量配置

在 `docker-compose.yml` 中或運行時設置以下環境變量：

- `GEMINI_API_KEY` - 您的 Google Gemini API 密鑰（必需）
- `NODE_ENV` - 運行環境（默認：production）
- `PORT` - 服務端口（默認：8080）

## GitHub Actions 自動部署

### 設置步驟

1. **啟用 GitHub Container Registry**
   - 在您的 GitHub 倉庫中，確保已啟用 GitHub Packages

2. **自動觸發構建**
   - 推送到 `main` 或 `master` 分支
   - 創建版本標籤（如 `v1.0.0`）
   - 手動觸發 workflow

3. **鏡像標籤規則**
   - `latest` - 最新的 main/master 分支
   - `v1.0.0` - 版本標籤
   - `main-<sha>` - 分支名稱 + commit SHA
   - `pr-123` - Pull Request 編號

### 使用發布的鏡像

```bash
# 拉取最新鏡像
docker pull ghcr.io/your-username/gemini:latest

# 運行
docker run -d \
  --name gemini-proxy \
  -p 8080:8080 \
  -e GEMINI_API_KEY=your_api_key_here \
  ghcr.io/your-username/gemini:latest
```

## 健康檢查

容器包含內置的健康檢查，會定期檢查 `/v1/models` 端點：

```bash
# 檢查容器健康狀態
docker ps
# 查看健康檢查日誌
docker inspect --format='{{json .State.Health}}' gemini-proxy
```

## 日誌管理

日誌會掛載到本地的 `./logs` 目錄：

```bash
# 查看應用程序日誌
docker-compose logs -f gemini-api

# 查看日誌文件
ls -la logs/
```

## 多平台支持

GitHub Actions 會自動構建支持以下平台的鏡像：
- `linux/amd64` - x86_64 架構
- `linux/arm64` - ARM64 架構（如 Apple M1/M2）

## 故障排除

### 常見問題

1. **容器無法啟動**
   ```bash
   # 檢查日誌
   docker logs gemini-proxy
   ```

2. **API 密鑰未設置**
   ```bash
   # 確保設置了環境變量
   docker run -e GEMINI_API_KEY=your_key ...
   ```

3. **端口衝突**
   ```bash
   # 更改映射端口
   docker run -p 3000:8080 ...
   ```

### 調試模式

```bash
# 以交互模式運行容器
docker run -it --rm \
  -e GEMINI_API_KEY=your_key \
  gemini-openai-proxy /bin/sh
```

## 生產環境建議

1. **使用特定版本標籤**而不是 `latest`
2. **設置資源限制**
3. **配置日誌輪轉**
4. **使用 secrets 管理 API 密鑰**
5. **設置監控和告警**

### 資源限制示例

```yaml
services:
  gemini-api:
    # ... 其他配置
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 512M
        reservations:
          cpus: '0.5'
          memory: 256M
```

## 安全注意事項

1. **不要在鏡像中硬編碼 API 密鑰**
2. **使用非 root 用戶運行容器**（已在 Dockerfile 中配置）
3. **定期更新基礎鏡像**
4. **掃描鏡像漏洞**

```bash
# 使用 Docker Scout 掃描漏洞（如果可用）
docker scout cves gemini-openai-proxy
```
