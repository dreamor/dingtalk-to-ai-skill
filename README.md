# Dingtalk-to-AI-Skill

> 当前版本: **v1.2.0**

通过钉钉群聊远程控制本地 AI CLI（OpenCode 或 Claude Code），在手机上随时随地与 AI 编码助手交互。

## 安装 Skill

### 方式一：Claude Code Plugin 安装（推荐）

```bash
/plugin marketplace add dreamor/dingtalk-to-ai-skill
/plugin install dingtalk-bridge
```

或在 Claude Code 中直接运行：
```
/plugin install https://github.com/dreamor/dingtalk-to-ai-skill
```

### 方式二：使用 npx skills 安装（通用）

```bash
# 一键安装
cd /path/to/your/project
npx skills add dreamor/dingtalk-to-ai-skill
```

安装后，所有 Claude Code / OpenCode 会话中均可使用：

```
/dingtalk-bridge setup    # 交互式配置
/dingtalk-bridge start    # 启动桥接服务
/dingtalk-bridge stop     # 停止桥接服务
/dingtalk-bridge status   # 查看状态
/dingtalk-bridge logs [N] # 查看日志(默认50行)
/dingtalk-bridge doctor   # 诊断问题
/dingtalk-bridge rebuild  # 重新构建
```

### 手动安装（克隆到本地）

如果 npx skills 命令不可用，可以使用克隆方式：

```bash
# 克隆到本地 skills 目录
git clone https://github.com/dreamor/dingtalk-to-ai-skill.git ~/.claude/skills/dingtalk-bridge
```

## 功能特性

- **双 AI Provider 支持**：支持 OpenCode CLI 和 Claude Code CLI
- **钉钉桥接**：通过钉钉群聊机器人接收消息并回复
- **多轮对话**：自动管理会话上下文
- **生产级特性**：消息去重、流量控制、并发限制

## 系统架构

```
钉钉群聊 → Stream SDK → Gateway → 消息队列 → AI CLI (OpenCode/Claude) → 响应 → 钉钉群聊
```

## 快速开始（不使用 Skill）

### 1. 克隆项目并安装依赖

```bash
git clone https://github.com/dreamor/dingtalk-to-ai-skill.git
cd dingtalk-to-ai-skill
npm install
npm run build
```

### 2. 配置

```bash
cp .env.example .env
```

编辑 `.env`，填入钉钉应用凭证：

```bash
DINGTALK_APP_KEY=your_app_key
DINGTALK_APP_SECRET=your_app_secret
```

### 3. 选择 AI Provider

```bash
# 使用 OpenCode CLI（默认，适合聊天）
AI_PROVIDER=opencode

# 使用 Claude Code CLI（适合项目任务）
AI_PROVIDER=claude
```

### 4. 启动

```bash
# 方式一：使用 PM2（推荐，生产环境）
bash start.sh

# 方式二：直接运行（开发调试）
npm run dev
```

服务启动后使用 Stream 模式连接钉钉，支持自动重连。

### 5. 使用

在钉钉群聊中发送消息，AI CLI 会在本地执行并返回结果。

## 管理命令

```bash
# 启动（推荐）
bash start.sh

# 停止
pm2 stop dingtalk-bot

# 状态
pm2 status

# 查看日志
pm2 logs dingtalk-bot

# 重新构建
npm run build

# 诊断
npm run dev  # 查看输出日志
```

## 配置说明

| 变量                              | 说明                                | 默认值      |
| --------------------------------- | ----------------------------------- | ----------- |
| **钉钉配置**                      |                                     |             |
| `DINGTALK_APP_KEY`                | 钉钉应用 Key                        | 必填        |
| `DINGTALK_APP_SECRET`             | 钉钉应用 Secret                     | 必填        |
| **AI 配置**                       |                                     |             |
| `AI_PROVIDER`                     | AI CLI 类型 (opencode/claude)       | opencode    |
| `OPENCODE_COMMAND`                | OpenCode 命令                       | opencode    |
| `OPENCODE_TIMEOUT`                | OpenCode 超时(毫秒)                 | 120000      |
| `OPENCODE_MAX_RETRIES`            | OpenCode 最大重试次数               | 3           |
| `OPENCODE_MODEL`                  | OpenCode 模型名称                   | CLI 默认    |
| `CLAUDE_COMMAND`                  | Claude Code 命令                    | claude      |
| `CLAUDE_TIMEOUT`                  | Claude Code 超时(毫秒)              | 120000      |
| `CLAUDE_MAX_RETRIES`              | Claude Code 最大重试次数            | 3           |
| `CLAUDE_MODEL`                    | Claude Code 模型名称                | CLI 默认    |
| **Gateway 配置**                  |                                     |             |
| `GATEWAY_PORT`                    | 服务端口                            | 3000        |
| `GATEWAY_HOST`                    | 服务主机                            | 0.0.0.0     |
| `GATEWAY_API_TOKEN`               | API 访问令牌                        | 可选        |
| **会话配置**                      |                                     |             |
| `SESSION_TTL`                     | 会话超时(毫秒)                      | 1800000     |
| `SESSION_MAX_HISTORY`             | 最大历史消息数                      | 50          |
| **消息队列配置**                  |                                     |             |
| `MQ_MAX_CONCURRENT_PER_USER`      | 每用户最大并发                      | 3           |
| `MQ_MAX_CONCURRENT_GLOBAL`        | 全局最大并发                        | 10          |
| `MQ_RATE_LIMIT_TOKENS`            | 令牌桶最大令牌数                    | 10          |
| **Stream 配置**                   |                                     |             |
| `STREAM_ENABLED`                  | 启用 Stream 模式                    | true        |
| `STREAM_MAX_RECONNECT`            | 最大重连次数                        | 10          |
| `STREAM_RECONNECT_BASE_DELAY`     | 重连基础延迟(毫秒)                  | 1000        |
| `STREAM_RECONNECT_MAX_DELAY`      | 重连最大延迟(毫秒)                  | 60000       |

## AI Provider 选择

| Provider   | 适用场景     | 安装方式                               |
| ---------- | ------------ | -------------------------------------- |
| `opencode` | 日常聊天对话 | `npm install -g opencode`              |
| `claude`   | 项目开发任务 | `brew install anthropic/claude/claude` |

## API 接口

| 接口          | 方法 | 描述                            |
| ------------- | ---- | ------------------------------- |
| `/health`     | GET  | 健康检查                        |
| `/api/status` | GET  | 系统状态（含 AI Provider 状态） |
| `/api/doctor` | GET  | 诊断检查                        |

## 项目结构

```
src/
├── dingtalk/          # 钉钉 SDK 集成 (Stream/Polling)
├── gateway/           # HTTP 网关
├── opencode/          # OpenCode 执行器
├── claude/           # Claude Code 执行器
├── session-manager/   # 会话管理
├── message-queue/    # 消息队列 (并发控制/流量限制)
├── polling/          # 轮询模式管理
├── types/            # TypeScript 类型定义
└── utils/            # 工具函数

scripts/
├── daemon.sh         # 服务管理脚本
└── doctor.sh         # 诊断脚本

docs/
├── images/           # 图片资源
└── superpowers/     # 功能文档
```

## 开发命令

```bash
npm run build        # 编译 TypeScript
npm run dev          # 开发模式
npm test             # 运行测试
npm run lint         # 代码检查
```

## License

MIT License - 查看 [LICENSE](LICENSE) 文件
