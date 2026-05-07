# 钉钉 AI 助手 — 提升计划（参考 cc-connect）

> 创建日期：2026-05-07
> 参考项目：[cc-connect](https://github.com/chenhg5/cc-connect) (Go, 7.8k stars)
> 约束：仅 Claude Code + OpenCode，仅钉钉平台

---

## 背景

对比 cc-connect 后，筛选出适合本项目的设计模式。当前项目 v1.5.0 核心功能可用（消息收发、流式卡片、会话池、队列、定时任务），但对比 cc-connect 在以下方面有明显差距：

---

## P1：会话空闲轮转（防上下文漂移）

### cc-connect 怎么做

- `reset_on_idle_mins`（默认 30 分钟）：用户空闲超时后，**下一条消息自动开新会话**
- 旧会话不删除，保留在 `/list`，可通过 `/switch` 切回
- 官方解释：workspace pool 每 15min 驱逐 session → 下次消息 `--continue` 恢复 → 反复注入失败命令、调试噪声 → 模型注意力漂移

### 本项目当前做法

- `SessionManager` 只有简单 TTL（默认 30min）→ 过期后创建新会话
- 问题 1：过期是"删除"不是"归档"，旧消息历史直接丢
- 问题 2：没有"下一次消息"的触发逻辑，只是被动清理
- 问题 3：Claude persistent session（SessionPool）的 `--continue` 会反复注入旧上下文

### 改造方案

1. `SessionManager` 增加 `idleResetMs` 配置（env: `SESSION_IDLE_RESET_MINS`，默认 30）
2. 会话状态增加 `idle`（非 `expired`），idle 会话保留消息历史
3. `getOrCreateSession(userId)` 逻辑：存在 active 会话但空闲超时 → 归档为 idle，创建新会话
4. 增加 `/list`、`/switch <id>` 命令支持（如当前没有完整实现）
5. Claude SessionPool 在会话轮转时也对应重建连接

**目标效果**：用户离开 30min 后回来发消息 → 自动获得干净会话，Agent 从 clean slate 开始；想看之前的内容可 `/switch` 切回

---

## P2：Display Mode（中间消息展示策略）

### cc-connect 怎么做

```toml
[display]
mode = "full"             # full | compact | quiet
thinking_messages = true  # 是否显示思考消息
thinking_max_len = 300    # 截断长度
tool_messages = true      # 是否显示工具调用
tool_max_len = 500        # 截断长度
```

三种模式：

- `full`：每条 thinking/tool_use 都单独发送消息
- `compact`：隐藏 thinking 和 tool_use，每段文本独立发送
- `quiet`：隐藏 thinking 和 tool_use，所有文本合并一张卡片，末尾 done emoji

### 本项目当前做法

- 流式卡片（StreamingCard）直接透传 Claude 输出，中间消息和控制混杂
- 没有中间消息的过滤/截断/展示策略

### 改造方案

1. `config.ts` 增加 `display.mode`、`display.thinkingMessages`、`display.thinkingMaxLen`、`display.toolMessages`、`display.toolMaxLen`
2. 在流式输出管道中增加 `DisplayFilter` 中间层：
   - 解析 stream-json 输出（区分 thinking / tool_use / assistant text）
   - 根据 mode 决定发送/跳过/截断
3. `compact` 为默认值——适合钉钉群聊场景（不刷屏）
4. 截断策略：超出 maxLen 显示前 N 字 + `...(truncated)`

**目标效果**：用户在群里不会看到大段思考过程刷屏，Agent 的工具调用过程简洁可追踪

---

## P3：Permission Mode 配置化

### cc-connect 怎么做

```toml
[projects.agent.options]
mode = "default"  # default | acceptEdits | plan | auto | bypassPermissions
```

运行时 `/mode` 切换：

- `/mode` — 查看当前和可用模式
- `/mode yolo` — 切到全部自动批准
- `/mode default` — 切回逐个确认

### 本项目当前做法

三处硬编码 `--dangerously-skip-permissions`：

- `claude/executor.ts` 行 291
- `claude/session.ts` 行 195
- `claude/executor.ts::initSessionPool()`

### 改造方案

1. `config.ts` 增加 `claude.permissionMode`（env: `CLAUDE_PERMISSION_MODE`，默认 `"default"`）
2. 三处硬编码统一读 `config.claude.permissionMode`
3. **兼容现有行为**：现有 `.env` 加 `CLAUDE_PERMISSION_MODE=bypassPermissions` 即可
4. CommandHandler 增加 `/mode` 命令，运行时切换并更新内存中的 config 值

**目标效果**：默认安全，有需要的用户显式开启 YOLO 模式

---

## P4：群聊会话共享（share_session_in_channel）

### cc-connect 怎么做

```toml
[[projects.platforms]]
[projects.platforms.options]
share_session_in_channel = false  # 默认每个用户独立会话
```

设为 `true` 则群聊中所有用户共享同一个 Agent 会话（多人协作场景）

### 本项目当前做法

`getOrCreateSession` 是 1:1 用户到会话的映射，群聊里不同人发消息各用各的 session

### 改造方案

1. `SessionManager` 增加按 conversationId 查找会话的能力
2. `config.ts` 增加 `session.shareSessionInGroup`（env: `SESSION_SHARE_IN_GROUP`，默认 `false`）
3. 当开启时，群聊消息用 `conversationId` 而非 `userId` 查找会话

**目标效果**：多人协作项目时，群里所有人跟同一个 Agent 对话，上下文共享

---

## P5：新增 Slash Commands

### cc-connect 有本项目缺的

| 命令            | 功能                         | cc-connect 位置    |
| --------------- | ---------------------------- | ------------------ |
| `/history [n]`  | 显示最近 n 条消息（默认 10） | session management |
| `/stop`         | 终止当前 Agent 执行          | session management |
| `/dir [path]`   | 查看或切换工作目录           | session management |
| `/allow <tool>` | 预批准某工具（下次会话生效） | session management |
| `/usage`        | 显示账户/模型配额            | session management |

### 改造方案

1. `/history` — 从当前 session 的 messages 数组取最后 N 条，格式化返回
2. `/stop` — 向当前 Agent 进程发 SIGINT，ClaudeSession.kill()
3. `/dir` — 查看当前 work_dir，支持传入 path 切换（注意需限制 admin_from 用户）
4. `/allow` — 写入 session metadata 的 allowlist，下次 spawn 时注入 --allowedTools

**目标效果**：钉钉群里就能完成日常会话管理，不用 SSH 到服务器

---

## P6：allow_from 访问控制

### cc-connect 怎么做

```toml
[projects.platforms.options]
allow_from = "*"  # "*" 表示所有人，也可写 "user1,user2"
```

### 本项目当前做法

无访问控制，收到消息就处理

### 改造方案

1. `config.ts` 增加 `dingtalk.allowFrom`（env: `DINGTALK_ALLOW_FROM`，默认 `"*"`）
2. 在 `stream.ts::handleMessage()` 中，提取 senderId 后检查白名单
3. 不在白名单的用户回复"你没有使用权限"

---

## P7：基础设施强化

1. **ESLint 规则升级** — type-safety 规则从 `"warn"` → `"error"`，作为 CI 门禁
2. **CI/CD Pipeline** — `.github/workflows/ci.yml`：lint → tsc --noEmit → npm test
3. **修复失败测试** — `src/dingtalk/__tests__/streamingCard.test.ts` 第 192 行，axios 未 mock 导致超时
4. **会话 SQLite 持久化** — 新增 `sessions` 表，启动恢复未过期会话
5. **Token 感知的历史截断** — `maxTokens` 参数（默认 8000），CJK 2chars/token, ASCII 4chars/token
6. **背压保护** — 队列深度超过阈值返回"系统繁忙"
7. **Metrics 端点** — `GET /api/metrics` 暴露消息处理数、失败数、限流等指标
8. **健康检查增强** — 返回 stream 连接状态、consumer 状态、SQLite 连通性

---

## 删除不必要模块

移除不需要的半成品模块以保持代码库干净：

- `src/platforms/` — 仅钉钉，不需要多平台抽象
- `src/project/` — 单项目部署，不需要多项目管理
- `src/relay/` — 不需要 bot-to-bot relay
- `src/utils/sandbox.ts` — 暂无用户隔离需求

---

## 实施顺序

| 阶段 | 内容                                                 | 预计 |
| ---- | ---------------------------------------------------- | ---- |
| 1    | 删除不需要模块 + ESLint 规则升级 + 修复失败测试 + CI | 4h   |
| 2    | Permission mode 配置化 + allow_from                  | 3h   |
| 3    | 会话空闲轮转（核心改造）                             | 4h   |
| 4    | Display mode（中间消息过滤）                         | 4h   |
| 5    | 新增 slash commands（/history, /stop, /dir）         | 3h   |
| 6    | 群聊会话共享（可选）                                 | 2h   |
| 7    | 会话 SQLite 持久化 + token 感知截断                  | 4h   |
| 8    | 健康检查增强 + metrics 端点 + 背压保护               | 4h   |

---

## 关键文件

**新建**：

- `.github/workflows/ci.yml`
- `src/display/DisplayFilter.ts`
- `src/observability/metrics.ts`

**关键修改**：

- `src/session-manager/sessionManager.ts` — idle session 归档 + archive 列表 + SQLite 持久化
- `src/config.ts` — idle_reset、display、permissionMode、share_session、allowFrom
- `src/commands/commandHandler.ts` — /history, /stop, /dir 命令
- `src/gateway/index.ts` — display filter 接入流式管道、会话轮转触发
- `src/dingtalk/stream.ts` — allow_from 白名单检查
- `src/claude/executor.ts` — permissionMode 配置化
- `src/claude/session.ts` — permissionMode 配置化
- `eslint.config.mjs` — rules warn→error
- `.env.example` — 新环境变量

**删除**：

- `src/platforms/`
- `src/project/`
- `src/relay/`
- `src/utils/sandbox.ts`
