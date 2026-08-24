# RSS 订阅通知监控

> 轻量级 RSS 订阅聚合 + AI 智能摘要 + 多渠道通知推送系统。支持 Docker 一键部署，响应式现代界面，适合自托管。

![Node](https://img.shields.io/badge/node-%3E%3D20-green)
![License](https://img.shields.io/badge/license-MIT-blue)
![Docker](https://img.shields.io/badge/docker-ready-blue)

---

## 功能特性

- **RSS 源管理**：添加/编辑/删除、启用开关、采集间隔配置、GitHub 仓库地址智能转为订阅地址（Releases/Commits/Tags）
- **版本概览**：按最新更新时间倒序展示每个订阅源的最新版本、更新时间与 AI 总结
- **文章列表**：分页浏览、按源筛选、一键 AI 总结、原文跳转
- **AI 智能摘要**：OpenAI 兼容接口，支持多模型轮询、故障转移、并发限流（3 并发）、内容哈希缓存避免重复调用
- **多渠道通知**：企业微信 Webhook / 自定义 POST / GET，支持按源绑定通道、消息模板变量（`{{Title}}`/`{{Summary}}`/`{{Link}}` 等）、批量聚合推送
- **通知日志与缓存管理**：查看推送记录，一键清理文章/日志/摘要缓存
- **安全登录**：基于 `bcrypt` 的密码认证 + SQLite 持久化 Session（重启不丢登录态，rolling 续期）
- **定时采集**：`node-cron` 每 5 分钟自动巡检，支持手动“立即采集”
- **现代 UI**：响应式、紧凑、卡片式设计，移动端友好

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Node.js 20 + Express 4 + TypeScript + better-sqlite3 |
| 前端 | 原生 HTML/CSS/JS（无框架，单文件 `web/static/index.html`） |
| AI | Vercel AI SDK (`ai` + `@ai-sdk/openai`)，兼容任意 OpenAI 接口 |
| 定时 | node-cron |
| 部署 | Docker / Docker Compose |

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
git clone https://github.com/yuloop/rss-dingyue.git
cd rss-dingyue

# 可选：自定义环境变量
cp .env.example .env
# 编辑 .env，修改 SESSION_SECRET 等

docker-compose up -d --build
# 访问 http://localhost:1471
# 默认密码：admin123（登录后请及时修改）
```

数据持久化在 `./data/rss.db`（已挂载到容器 `/app/data`）。

### 方式二：本地开发

```bash
npm install
npm run dev      # tsx watch src/index.ts，默认端口 1471
# 或
npm run build
npm start
```

环境变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `1471` |
| `DATA_DIR` | 数据库目录 | `./data` |
| `SESSION_SECRET` | Session 加密密钥 | `rss-dingyue-secret-key-2024` |
| `SESSION_MAX_AGE_DAYS` | 登录有效期（天） | `30` |

## 配置说明

### RSS 源

- 支持任意标准 RSS/Atom 地址，GitHub 输入 `https://github.com/owner/repo` 时前端会自动提示转为 `releases.atom` / `commits.atom` / `tags.atom`
- 每个源可独立绑定通知通道，未绑定则使用所有已启用通道

### AI 配置

- 兼容 OpenAI 及任意兼容接口（如 Moonshot、DeepSeek、OpenRouter 等，仅需填 `API URL` + `API Key`）
- 支持多模型逗号分隔，轮询调用；可设优先级与故障转移备用配置
- 相同标题+内容会命中 `summary_cache`，避免重复消耗 Token

### 通知配置

- **企业微信 Webhook**：直接发送 `msgtype: text` 格式
- **POST**：可自定义 `headers`（JSON）与 `bodyTemplate`，支持变量替换
- **GET**：URL 中使用 `{{Title}}` 等变量，自动 URL 编码

变量列表：`{{Title}}` `{{Link}}` `{{Source}}` `{{Summary}}` `{{Content}}` `{{Time}}`

### 定时任务

- 服务内 `cron.schedule('*/5 * * * *')` 每 5 分钟执行 `processNewEntries()`：拉取 → AI 总结（限流 3 并发）→ 批量通知
- 可通过前端“立即采集”手动触发

## API 概览

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/api/auth/check` | 检查登录态 | 否 |
| POST | `/api/auth/login` | 登录 | 否 |
| POST | `/api/auth/logout` | 登出 | 否 |
| POST | `/api/auth/change-password` | 修改密码 | 是 |
| GET | `/api/sources` | 列出 RSS 源 | 是 |
| GET | `/api/sources/overview` | 概览（最新版本） | 是 |
| POST | `/api/sources/test` | 测试 RSS 连通性 | 是 |
| POST | `/api/sources/preview/:id` | 预览源内容 | 是 |
| POST | `/api/sources/test-workflow/:id` | 端到端测试（拉取→总结→通知） | 是 |
| GET | `/api/entries` | 文章列表 | 是 |
| POST | `/api/notify` | 通知配置 CRUD | 是 |
| POST | `/api/notify/test` | 测试通知 | 是 |
| GET | `/api/ai` | AI 配置 CRUD | 是 |
| POST | `/api/ai/test` | 测试 AI 连通 | 是 |
| GET | `/api/cache/stats` | 缓存统计 | 是 |
| POST | `/api/cache/clear-*` | 清理缓存 | 是 |

## 项目结构

```
rss-dingyue/
├── src/
│   ├── index.ts          # Express 入口、路由、定时任务
│   ├── store.ts          # SQLite 初始化与数据访问层
│   ├── rss.ts            # RSS 拉取与入库
│   ├── ai.ts             # AI 摘要（限流/缓存/故障转移）
│   ├── notify.ts         # 通知推送（单条/批量）
│   ├── time.ts           # 北京时间工具
│   ├── session-store.ts  # SQLite Session 存储
│   └── types.ts          # 类型定义
├── web/static/index.html # 前端单页应用
├── data/                 # SQLite 数据（运行时生成，git 忽略）
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Docker 部署注意

- 已配置 `restart: unless-stopped` 与 `healthcheck`，异常自动重启
- 时区固定为 `Asia/Shanghai`，保证 `getBeijingTime()` 与容器时间一致
- 升级时注意保留 `data` 目录：`docker-compose down` 不会删除挂载卷，重新 `up -d --build` 即可

## 安全建议

- 首次登录后立即修改默认密码 `admin123`
- 生产环境务必通过 `.env` 设置强随机 `SESSION_SECRET`
- 不要将 `data/rss.db` 提交到 Git（已在 `.gitignore` 中排除）
- AI `apiKey` 与通知 Webhook URL 属于敏感信息，仅存储在本地数据库，切勿公开分享

## 常见问题

**Q: better-sqlite3 安装失败？**
A: 需要 Python + make + g++，Docker 镜像已内置；本地安装请确保已装编译工具，或使用 Node 20。

**Q: GitHub Releases 订阅地址是什么？**
A: `https://github.com/{owner}/{repo}/releases.atom`，Commits 为 `commits.atom`，Tags 为 `tags.atom`。本项目前端会自动识别并提示转换。

**Q: 如何备份数据？**
A: 直接拷贝 `data/rss.db` 即可；恢复时放回同路径并重启容器。

## 许可证

MIT License - 详见 [LICENSE](./LICENSE)

## 致谢

- [rss-parser](https://github.com/rbren/rss-parser)
- [Vercel AI SDK](https://sdk.vercel.ai/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
