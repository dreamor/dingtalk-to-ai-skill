# Dingtalk-to-AI-Skill

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
- **聊天命令**：支持 `/help`、`/status`、`/model` 等斜杠命令
- **项目记忆**：自动记忆对话上下文，跨会话保留关键信息
- **媒体处理**：支持语音转文字、图片描述等富媒体消息
- **多 Agent 路由**：根据规则自动选择 AI Provider 处理消息
- **定时任务**：支持 cron 格式的定时消息处理
- **交互式卡片**：钉钉互动卡片消息支持
- **生产级特性**：消息去重、流量控制、并发限制
- **消息重试**：发送失败自动重试，支持指数退避
- **SQLite 持久化**：可选的消息队列、会话、记忆持久化存储
- **结构化日志**：多级别日志输出，支持 JSON/Pretty 格式
- **增强健康检查**：多维度的系统健康状态检查

## 系统架构

```
钉钉群聊 → Stream SDK → Gateway → 消息队列 → 路由 → AI CLI (OpenCode/Claude) → 响应 → 钉钉群聊
                              ↓              ↓
                        SQLite 持久化    项目记忆
                              ↓
                     媒体处理 / 定时任务 / 交互卡片
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

### 聊天命令

在钉钉群聊中发送以 `/` 开头的消息即可触发命令：

| 命令 | 说明 |
|------|------|
| `/help` | 显示所有可用命令 |
| `/status` | 显示系统状态 |
| `/model` | 查看/切换 AI 模型 |
| `/history` | 显示最近对话历史 |
| `/queue` | 显示消息队列状态 |
| `/config` | 显示当前配置（脱敏） |
| `/reset` | 重置当前会话 |
| `/remember <key> <value>` | 保存记忆 |

## 管理命令

```bash
# 构建
npm run build

# 启动（PM2，推荐生产环境）
pm2 start ecosystem.config.cjs

# 停止
pm2 stop dingtalk-bot

# 重启
pm2 restart dingtalk-bot

# 状态
pm2 status

# 查看日志
pm2 logs dingtalk-bot

# 诊断
npm run dev  # 开发模式查看输出日志
```

## 配置说明

<!-- AUTO-GENERATED: Environment variables from .env.example -->
| 变量                             | 说明                          | 默认值      |
| -------------------------------- | ----------------------------- | ----------- |
| **钉钉配置**                     |                                |             |
| `DINGTALK_APP_KEY`               | 钉钉应用 Key (ClientID)        | 必填        |
| `DINGTALK_APP_SECRET`            | 钉钉应用 Secret (ClientSecret) | 必填        |
| **Gateway 配置**                 |                                |             |
| `GATEWAY_PORT`                   | 服务端口                      | 3000        |
| `GATEWAY_HOST`                   | 服务主机                      | 0.0.0.0     |
| `GATEWAY_API_TOKEN`              | API 访问令牌                  | 可选        |
| **AI 配置**                      |                                |             |
| `AI_PROVIDER`                    | AI CLI 类型 (opencode/claude) | opencode    |
| **OpenCode CLI 配置**            |                                |             |
| `OPENCODE_COMMAND`               | OpenCode 命令                  | opencode    |
| `OPENCODE_TIMEOUT`               | 执行超时(毫秒)                | 120000      |
| `OPENCODE_MAX_RETRIES`           | 最大重试次数                  | 3           |
| `OPENCODE_WORKING_DIR`           | 工作目录                      | 当前目录    |
| `OPENCODE_MODEL`                 | 模型名称                      | CLI 默认    |
| `OPENCODE_MAX_INPUT_LENGTH`      | 最大输入长度(字符)            | 10000       |
| `OPENCODE_RETRY_BASE_DELAY`      | 基础重试延迟(毫秒)            | 1000        |
| `OPENCODE_RETRY_MAX_DELAY`       | 最大重试延迟(毫秒)            | 10000       |
| **Claude Code CLI 配置**         |                                |             |
| `CLAUDE_COMMAND`                 | Claude Code 命令               | claude      |
| `CLAUDE_TIMEOUT`                 | 执行超时(毫秒)                | 120000      |
| `CLAUDE_MAX_RETRIES`             | 最大重试次数                  | 3           |
| `CLAUDE_WORKING_DIR`             | 工作目录                      | 当前目录    |
| `CLAUDE_MODEL`                   | 模型名称                      | CLI 默认    |
| `CLAUDE_MAX_INPUT_LENGTH`        | 最大输入长度(字符)            | 10000       |
| `CLAUDE_RETRY_BASE_DELAY`        | 基础重试延迟(毫秒)            | 1000        |
| `CLAUDE_RETRY_MAX_DELAY`         | 最大重试延迟(毫秒)            | 10000       |
| **会话管理配置**                 |                                |             |
| `SESSION_TTL`                    | 会话生存时间(毫秒)            | 1800000     |
| `SESSION_MAX_HISTORY`            | 最大历史消息数                | 50          |
| **消息队列配置**                 |                                |             |
| `MQ_MAX_CONCURRENT_PER_USER`     | 每用户最大并发                | 3           |
| `MQ_MAX_CONCURRENT_GLOBAL`       | 全局最大并发                  | 10          |
| `MQ_RATE_LIMIT_TOKENS`           | 令牌桶最大令牌数              | 10          |
| `MQ_POLL_INTERVAL`               | 队列轮询间隔(毫秒)            | 100         |
| `MQ_ENABLE_PERSISTENCE`          | 启用 SQLite 队列持久化        | true        |
| **持久化存储配置**               |                                |             |
| `STORAGE_DB_PATH`                | SQLite 数据库路径             | ./data/dingtalk.db |
| `STORAGE_ENABLE_WAL`             | 启用 WAL 模式                 | true        |
| `STORAGE_CLEANUP_INTERVAL`       | 清理间隔(毫秒)                | 3600000     |
| **Stream 模式配置**              |                                |             |
| `STREAM_ENABLED`                 | 启用 Stream 模式              | true        |
| `STREAM_MAX_RECONNECT`           | 最大重连次数                  | 10          |
| `STREAM_RECONNECT_BASE_DELAY`    | 重连基础延迟(毫秒)            | 1000        |
| `STREAM_RECONNECT_MAX_DELAY`     | 重连最大延迟(毫秒)            | 60000       |
| **媒体处理配置**                 |                                |             |
| `MEDIA_ENABLED`                  | 启用媒体处理                  | true        |
| `MEDIA_VOICE_TRANSCRIPTION`      | 启用语音转文字                | false       |
| `MEDIA_IMAGE_DESCRIPTION`        | 启用图片描述                  | false       |
| `MEDIA_MAX_FILE_SIZE`            | 最大文件大小(字节)            | 10485760    |
| `MEDIA_DOWNLOAD_TIMEOUT`         | 下载超时(毫秒)                | 30000       |
| **多 Agent 路由配置**            |                                |             |
| `ROUTER_ENABLED`                 | 启用路由功能                  | false       |
| `ROUTER_PROVIDERS`               | Provider 列表(JSON)           | -           |
| `ROUTER_RULES`                   | 路由规则列表(JSON)            | -           |
| **定时任务配置**                 |                                |             |
| `SCHEDULER_ENABLED`              | 启用定时任务                  | false       |
| `SCHEDULER_TASKS`                | 任务列表(JSON)                | -           |
| **项目记忆配置**                 |                                |             |
| `MEMORY_ENABLED`                 | 启用项目记忆                  | true        |
| `MEMORY_AUTO_SUMMARIZE`          | 启用自动摘要                  | true        |
| `MEMORY_SUMMARIZE_THRESHOLD`     | 摘要触发阈值(消息数)          | 20          |
| `MEMORY_MAX_CONTEXT`             | 上下文最大记忆数              | 10          |
| `MEMORY_AUTO_MAX_AGE`            | 自动记忆最大存活时间(毫秒)    | 7776000000  |
| `MEMORY_BOOST_ON_ACCESS`         | 访问时提升记忆权重            | true        |
| `MEMORY_BOOST_INCREMENT`         | 权重提升增量(0.1~1.0)         | 0.1         |
| **告警通知配置**                 |                                |             |
| `ALERT_ADMIN_USER_ID`            | 管理员用户 ID                  | -           |
| `ALERT_MENTION_USERS`            | 告警 @ 用户(手机号,逗号分隔)  | -           |
| `ALERT_MENTION_ALL`              | 告警 @ 所有人                 | false       |
| **日志配置**                     |                                |             |
| `LOG_LEVEL`                      | 日志级别                      | info        |
| `LOG_FORMAT`                     | 日志格式 (json/pretty)        | pretty      |
| `LOG_ENABLE_FILE`                | 启用文件日志                  | false       |
<!-- AUTO-GENERATED END -->

## AI Provider 选择

| Provider | 适用场景 | 安装方式 |
|----------|----------|----------|
| `opencode` | 日常聊天对话 | `npm install -g opencode` |
| `claude` | 项目开发任务 | `brew install anthropic/claude/claude` |

## API 接口

| 接口 | 方法 | 描述 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/api/status` | GET | 系统状态（含 AI Provider、消息队列、重试队列等） |
| `/api/doctor` | GET | 诊断检查（内存、CLI、配置等） |
| `/api/sessions` | GET | 会话统计 |
| `/api/queue` | GET | 队列状态 |
| `/api/test` | POST | 测试消息处理 |

## 项目结构

```
src/
├── dingtalk/          # 钉钉 SDK 集成 (Stream 模式 + 交互卡片)
├── gateway/           # HTTP 网关
│   ├── errorFormatter.ts  # 错误格式化
│   ├── retrySender.ts     # 消息重试发送器
│   ├── queueConsumer.ts   # 队列消费者
│   └── aiDegradation.ts   # AI CLI 优雅降级
├── opencode/          # OpenCode 执行器
├── claude/            # Claude Code 执行器
├── commands/          # 聊天命令系统 (/help, /status 等)
│   ├── commandParser.ts   # 命令解析
│   └── commandHandler.ts  # 命令处理
├── memory/            # 项目记忆模块
│   ├── memoryStore.ts     # 记忆存储 (SQLite)
│   └── memoryManager.ts   # 记忆管理 (自动摘要/上下文注入)
├── media/             # 媒体处理模块
│   ├── mediaDownloader.ts # 媒体下载
│   └── mediaProcessor.ts  # 媒体处理 (语音/图片)
├── router/            # 多 Agent 路由
│   ├── provider.ts        # Provider 注册
│   └── router.ts          # 消息路由规则
├── scheduler/         # 定时任务调度器
│   └── scheduler.ts       # Cron 任务调度
├── session-manager/   # 会话管理
├── message-queue/     # 消息队列 (并发控制/流量限制)
├── storage/           # SQLite 持久化存储
├── health/            # 健康检查模块
├── logger/            # 结构化日志
├── types/             # TypeScript 类型定义
└── utils/             # 工具函数

scripts/
├── daemon.sh          # 服务管理脚本
└── doctor.sh          # 诊断脚本

docs/
├── images/            # 图片资源
└── superpowers/       # 功能文档
```

## 开发命令

<!-- AUTO-GENERATED: Scripts reference from package.json -->
```bash
npm run build          # 编译 TypeScript
npm run start          # 运行生产构建
npm run dev            # 开发模式 (ts-node)
npm test               # 运行测试
npm run test:coverage  # 运行测试并生成覆盖率报告
npm run lint           # 代码检查
npm run lint:fix       # 代码检查并自动修复
```
<!-- AUTO-GENERATED END -->

## 更新日志

### v1.5.0
- 新增聊天命令系统（/help, /status, /model, /history, /queue, /config, /reset, /remember）
- 新增项目记忆模块（自动摘要、上下文注入、访问权重提升）
- 新增媒体处理模块（语音转文字、图片描述）
- 新增多 Agent 路由（按规则自动选择 Provider）
- 新增定时任务调度器（Cron 格式）
- 新增钉钉交互式卡片消息支持
- 移除管理员权限限制（单用户场景无需管理员概念）

### v1.4.0
- 消息队列支持 SQLite 持久化（重启后消息不丢失）
- 服务启动时自动恢复未处理消息
- 消息状态实时同步到数据库
- SQLite 故障时自动回退到内存模式
- 默认启用持久化存储

### v1.3.0
- 新增 SQLite 持久化存储支持
- 新增结构化日志系统（多级别、JSON/Pretty 格式）
- 新增增强健康检查（内存、AI CLI、配置）
- 新增消息重试发送机制
- 新增 AI CLI 不可用时的优雅降级
- 优化配置验证，添加值域检查
- 优化消息队列轮询间隔配置化
- 清理未使用的配置字段
- 测试覆盖率达到 100%

### v1.2.0
- 支持双 AI Provider (OpenCode/Claude Code)
- 消息重试机制
- 自动重连

## License

MIT License - 查看 [LICENSE](LICENSE) 文件
