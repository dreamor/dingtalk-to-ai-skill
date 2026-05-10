# AI Card 打字机效果排查进展

## 问题

钉钉 AI Card 没有流式输出效果，内容一次性显示而非逐段出现（打字机效果）。

## 已确认的根因

**Claude CLI `-p` 模式不产生增量 partial messages。**

通过直接测试 Claude CLI 输出验证：

```bash
echo '说5个字' | claude -p --output-format stream-json --include-partial-messages --verbose --dangerously-skip-permissions
```

结果：只产生 **1 个** `assistant` 事件，包含完整文本（如 54 字），没有增量 delta。

`--include-partial-messages` 标志在交互模式下会产出多个递增的 assistant 事件（text 从短到长），但在 `-p`（print）模式下只输出最终完整结果。

### 为什么必须用 `-p` 模式

- `--input-format stream-json` 和 `--output-format stream-json` 要求 `-p` 标志
- 没有 `-p` 时，CLI 进入交互 REPL 模式，stdin 无法通过管道发送消息
- 当前架构通过 `spawn` + `stdin.write()` 发送 NDJSON 消息，依赖 stream-json 格式

### 数据流链路

```
Claude CLI (-p mode)
  → 1个 assistant 事件（完整文本）
    → ClaudeSession.handleAssistantEvent()
      → delta 提取逻辑（但只有1个事件，delta=完整文本）
        → StreamingCardManager.appendChunk(完整文本)
          → 钉钉 PUT /v1.0/card/streaming（一次性推送）
            → 卡片一次性显示（无打字机效果）
```

## 已解决的问题

| #   | 问题                               | 修复                                                                | 时间  |
| --- | ---------------------------------- | ------------------------------------------------------------------- | ----- |
| 1   | streaming API 400 "Missingcontent" | `msgContent` → `content`（请求体字段名）                            | 05-09 |
| 2   | streaming API 500 "unknownError"   | 自定义模板 → 官方模板 `02fcf2f4-5e02-4a85-b672-46d1f715543e.schema` | 05-09 |
| 3   | thinking block TypeError           | `block.text ?? ''` 兜底                                             | 05-09 |
| 4   | PM2 MODULE_NOT_FOUND (Node v26)    | `npx pm2 update` 升级 daemon v7                                     | 05-09 |
| 5   | TypeScript build errors            | mediaDownloader String() 包裹                                       | 05-09 |

## 尝试过的方案

### 方案 1: `--include-partial-messages` + delta 提取 ❌

在 `ClaudeSession.handleAssistantEvent()` 中实现 delta 提取逻辑：

```typescript
if (
  text.startsWith(this.previousAssistantText) &&
  text.length > this.previousAssistantText.length
) {
  const delta = text.substring(this.previousAssistantText.length);
  this.accumulatedText += delta;
  this.previousAssistantText = text;
  this.callbacks.onText?.(delta);
}
```

**结果**：`-p` 模式下只有 1 个 assistant 事件，delta = 完整文本，无法分段。

### 方案 2: 客户端打字机模拟 ❌（当前）

在 `StreamingCardManager.appendChunk()` 中，当收到超过阈值的 chunk 时，启动打字机定时器分片喂入 `fullText`：

- 阈值：50 字符（`TYPEWRITER_THRESHOLD`）
- 每步：20 字符（`TYPEWRITER_CHUNK_SIZE`）
- 间隔：150ms（`TYPEWRITER_INTERVAL_MS`）
- 配合已有的 800ms 卡片刷新间隔产生逐步推送效果

**结果**：用户反馈仍然没有打字机效果。可能原因：

1. 打字机分片喂入速度（150ms/20字）与卡片刷新间隔（800ms）配合有问题
2. 钉钉卡片客户端可能在收到 `isFinalize=false` 的流式更新时，仍然等完整内容才渲染
3. 流式更新的 `isFull: true` 模式可能让钉钉替换整个内容而非追加

## 待排查方向

### 方向 A: 改用 Anthropic API 直连（推荐）

绕过 Claude CLI，直接调用 Anthropic Messages API：

- API 原生支持 `stream: true`，返回 Server-Sent Events
- 每个 SSE chunk 包含增量 `content_block_delta`
- 真正的 token 级流式输出
- **优点**：最可靠，完全掌控流式节奏
- **缺点**：需要重构 executor，放弃 CLI 的工具调用能力（或需自行实现 tool_use 循环）

### 方向 B: 调试钉钉卡片流式渲染机制

当前 `streamUpdate` 使用 `isFull: true`（每次发送全量内容），可能的问题：

- 尝试 `isFull: false`（增量模式），每次只发送新增的 delta
- 需要确认钉钉官方模板 `02fcf2f4-5e02-4a85-b672-46d1f715543e.schema` 的流式组件配置
- 参考钉钉官方文档：https://open.dingtalk.com/document/development/api-streamingupdate
- 需要确认：卡片客户端是逐次渲染还是等 `isFinalize=true` 才显示

### 方向 C: Claude CLI 交互模式（不使用 -p）

探索不用 `-p` 的 CLI 交互模式：

- `claude --input-format stream-json --output-format stream-json --include-partial-messages`
- 通过 stdin 发送 NDJSON 消息
- 进程保持长驻，`--include-partial-messages` 在交互模式下可能产出增量 partial messages
- **风险**：需要验证交互模式是否真的支持 stdin NDJSON 输入
- **风险**：进程生命周期管理更复杂

### 方向 D: 调整打字机参数 + isFull: false

当前客户端模拟方案可能参数不对：

1. 将 `isFull` 改为 `false`，每次只发送增量文本
2. 调整打字机参数：减小 `TYPEWRITER_CHUNK_SIZE`（如 5-10 字），增大 `TYPEWRITER_INTERVAL_MS`（如 300-500ms）
3. 在钉钉客户端观察是否有逐段更新效果
4. 如果 `isFull: false` 不行，尝试 `isFull: true` 但减少每次推送的文本量

## 关键文件

| 文件                            | 职责                                                    |
| ------------------------------- | ------------------------------------------------------- |
| `src/claude/session.ts`         | Claude CLI 持久化会话管理，delta 提取                   |
| `src/dingtalk/aiCardService.ts` | 钉钉 AI Card API 封装（createCard/streamUpdate/finish） |
| `src/dingtalk/streamingCard.ts` | 流式卡片管理器（打字机模拟、防抖刷新）                  |
| `src/gateway/index.ts`          | Gateway 消息处理，onText 回调接线                       |
| `src/claude/executor.ts`        | Claude Code 执行器                                      |
| `src/claude/sessionPool.ts`     | 会话池管理                                              |

## 环境信息

- Claude CLI: `/Users/scottwang/.local/bin/claude`
- 钉钉 AI Card 官方模板: `02fcf2f4-5e02-4a85-b672-46d1f715543e.schema`
- Node.js: v26.x
- PM2: v7.0.1
