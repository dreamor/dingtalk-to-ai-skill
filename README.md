# Dingtalk-to-AI-Skill

通过钉钉群聊远程控制本地 AI CLI（OpenCode 或 Claude Code），在手机上随时随地与 AI 编码助手交互。

## 安装 Skill

### 方式一：Claude Code Plugin 安装（推荐）

```bash
/plugin marketplace add dreamor/dingtalk-to-ai-skill
/plugin install dingtalk-bridge
```

### 方式二：使用 npx skills 安装

```bash
cd /path/to/your/project
npx skills add dreamor/dingtalk-to-ai-skill
```

安装后可使用：

```
/dingtalk-bridge setup    # 交互式配置
/dingtalk-bridge start    # 启动桥接服务
/dingtalk-bridge stop     # 停止桥接服务
/dingtalk-bridge status   # 查看状态
/dingtalk-bridge logs [N] # 查看日志
/dingtalk-bridge doctor   # 诊断问题
```

### 手动安装

```bash
git clone https://github.com/dreamor/dingtalk-to-ai-skill.git ~/.claude/skills/dingtalk-bridge
```

## 功能特性

- **双 AI Provider**：OpenCode CLI + Claude Code CLI
- **流式卡片**：AI Card 打字机效果实时输出
- **多轮对话**：自动管理会话上下文
- **项目记忆**：跨会话保留关键信息
- **媒体处理**：语音转文字、图片描述
- **多 Agent 路由**：根据规则自动选择 Provider
- **生产级**：消息去重、并发控制、自动重试、SQLite 持久化

## 系统架构

```
钉钉群聊 → Stream SDK → Gateway → 消息队列 → 路由 → AI CLI → 流式卡片 → 钉钉群聊
                              ↓              ↓
                        SQLite 持久化    项目记忆
```

### 项目结构

```
src/
├── dingtalk/          # 钉钉集成（Stream + AI Card 流式卡片）
├── gateway/           # HTTP 网关（健康检查、队列消费、重试）
├── opencode/          # OpenCode CLI 执行器
├── claude/            # Claude Code CLI 执行器（持久化会话）
├── agents/            # Agent 适配器注册中心
├── commands/          # 聊天命令（/help, /status, /model 等）
├── session-manager/   # 会话管理（TTL、历史）
├── message-queue/     # 消息队列（并发控制、流量限制）
├── router/            # 多 Agent 路由
├── scheduler/         # Cron 定时任务
├── memory/            # 项目记忆（自动摘要）
├── media/             # 媒体处理（语音、图片）
├── display/           # 显示过滤
├── storage/           # SQLite 持久化
├── health/            # 健康检查
├── logger/            # 结构化日志
└── utils/             # 工具函数
```

## 快速开始

```bash
git clone https://github.com/dreamor/dingtalk-to-ai-skill.git
cd dingtalk-to-ai-skill
npm install && npm run build
cp .env.example .env   # 编辑填入钉钉凭证
```

配置 `.env`：

```bash
DINGTALK_APP_KEY=your_app_key
DINGTALK_APP_SECRET=your_app_secret
AI_PROVIDER=opencode   # 或 claude
```

启动：

```bash
bash start.sh          # PM2 生产模式
# 或
npm run dev            # 开发调试
```

## 聊天命令

| 命令                      | 说明              |
| ------------------------- | ----------------- |
| `/help`                   | 显示所有可用命令  |
| `/status`                 | 显示系统状态      |
| `/model`                  | 查看/切换 AI 模型 |
| `/history`                | 显示最近对话历史  |
| `/queue`                  | 显示消息队列状态  |
| `/reset`                  | 重置当前会话      |
| `/remember <key> <value>` | 保存记忆          |

## AI Provider 选择

| Provider   | 适用场景     | 安装方式                               |
| ---------- | ------------ | -------------------------------------- |
| `opencode` | 日常聊天对话 | `npm install -g opencode`              |
| `claude`   | 项目开发任务 | `brew install anthropic/claude/claude` |

## 配置

完整配置说明见 `.env.example`，涵盖：钉钉凭证、AI Provider、会话管理、消息队列、Stream 模式、媒体处理、路由、定时任务、记忆、告警、日志等。

## API 接口

| 接口            | 方法 | 描述         |
| --------------- | ---- | ------------ |
| `/health`       | GET  | 健康检查     |
| `/api/status`   | GET  | 系统状态     |
| `/api/doctor`   | GET  | 诊断检查     |
| `/api/sessions` | GET  | 会话统计     |
| `/api/queue`    | GET  | 队列状态     |
| `/api/test`     | POST | 测试消息处理 |

## 开发

```bash
npm run build          # 编译 TypeScript
npm run dev            # 开发模式 (ts-node)
npm test               # 运行测试
npm run test:coverage  # 覆盖率报告
npm run lint:fix       # 代码检查并修复
```

## License

MIT License - 查看 [LICENSE](LICENSE) 文件
