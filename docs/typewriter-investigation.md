# AI Card 打字机效果排查进展

## 问题

钉钉 AI Card 没有流式输出效果，内容一次性显示而非逐段出现。

## 最新日志 (2026-05-09 15:39)

```
15:39:09 [AICard] 开始创建并投放卡片：用户 $, outTrackId=card_1778312349494_71zgwzld
15:39:09 [AICard] 卡片创建并投放成功：card_1778312349494_71zgwzld
15:39:09 [StreamingCard] AI Card 创建成功：card_...
15:39:09 🚀 持久化会话执行: c_moy19alapwet5ct0 - hello 翻译一下...
15:39:09 [SessionPool] 认领 spare 会话: __warm_spare_... → c_moy19alapwet5ct0
15:39:09 [ClaudeSession] 状态: ready → busy
15:39:09 [ClaudeSession] 会话初始化: session_id=..., model=claude-opus-4-7
15:39:12 [ClaudeSession] 状态: busy → ready
# ↑ 3秒内没有任何 appendChunk/onText log
15:39:12 [AICard] 流式更新：contentLen=63, isFinalize=false
15:39:13 [AICard] 流式更新响应：status=200
15:39:13 [AICard] 开始 finish：最终内容长度=63
15:39:13 [AICard] 流式更新响应：status=200
15:39:13 [AICard] 卡片完成
```

**关键发现：3 秒生成期间（15:39:09 → 15:39:12），没有任何 `appendChunk` / `onText` / `filterQuiet` 触发。卡片只有 finish 时一次更新（63 字符全量）。**

---

## 已排除的问题

| 假设                                 | 结论    | 依据                                                                |
| ------------------------------------ | ------- | ------------------------------------------------------------------- |
| TOKEN API 端点错误                   | ❌ 排除 | 日志显示卡片创建投放成功（HTTP 200）                                |
| 字段名错误 (content→msgContent)      | ❌ 排除 | 日志显示流式更新成功（HTTP 200）                                    |
| createAndDeliver 一步法问题          | ❌ 排除 | 已改为两步法，仍无效果                                              |
| DisplayFilter quiet 模式过滤         | ❌ 排除 | 默认是 compact 模式，text 应 shouldSend=true                        |
| finish 里 swap 内容不对              | ❌ 排除 | finish 里的 contentLen=63 是最终结果，与 swap 无关                  |
| 两个流式更新 (isFinalize=false/true) | ✅ 正常 | 这是 finish 的两阶段（先 finalize streaming，再设置 FINISHED 状态） |

---

## 当前代码路径（已验证）

````
用户发消息 → stream.ts → gateway.handleStreamMessage()
  → processMessage() → processMessageInternal()
    → useStreaming=true 时：
      1. streamingCardManager.startStream()     ← 卡片创建 ✓
      2. displayFilter = new DisplayFilter()   ← DisplayMode='compact' ✓
      3. usePersistentSession=true 时：
         executor.executeSession(convId, msg, callbacks)
           → sessionPool.send(convId, msg, callbacks)
             → session.send(msg, callbacks)
               → 写 NDJSON 到 stdin ✓
               → Promise resolved（但不等待 output）
    → streamHandle.finish(finalText)            ← finish 时才更新

onText callback 链路（代码正确，未确认触发）：
  Session.handleLine() → handleAssistantEvent(block.type==='text')
    → this.callbacks.onText?.(block.text)

onText 在 gateway/index.ts 的具体位置（行 842）：
```typescript
onText: async (text: string) => {
  const filtered = displayFilter.filter({ type: 'text', content: text });
  if (filtered.shouldSend && filtered.content) {
    await streamHandle.appendChunk(filtered.content);  // ← 未触发
  }
},
````

---

## 已实施的修改（不影响效果）

1. **`aiCardService.ts` — Token API 和 createAndDeliver → 两步法**
2. **`streamingCard.ts` — 防抖时间戳化 (500ms → 800ms，首发立即触发)**

---

## 待验证假设

### 假设 1（最可能）：NDJSON `onText` 根本没被调用

**问**：logs 完全没有 `appendChunk` 相关内容——是 callback 从未被触发，还是 logger 被过滤了？

**答**：不知道。需要加日志确认。

**验证方法**：在 gateway/index.ts 的 `onText` callback 里（第 842 行后）加一行：

```typescript
onText: async (text: string) => {
  console.log(`[Gateway] onText callback: ${text.substring(0, 100)}`);
  // ... existing code
},
```

然后看 PM2 日志里有没有这行。

### 假设 2：displayFilter.filter() 返回 shouldSend=false

**可能性**：很低（compact 模式对 text 类型应返回 true）。

**验证方法**：同假设 1 日志。

### 假设 3：NDJSON 行没有被 session.handleLine() 解析

可能原因：

- Claude CLI 的 `--output-format stream-json` 输出格式变了
- `block.type` 不是 `'text'`，而是其他格式（如 `content` 数组结构不同）
- readline 没有正确接收数据

**验证方法**：

```bash
# 测试 session.ts 的 mock 测试
npm test -- --testPathPattern="session" 2>&1 | tail -30
```

如果所有 session 测试通过，说明 handleLine 的 NDJSON 解析逻辑本身正确。根因在别处（process.stdin/stdout 没正确连接读写、CLI 输出格式与 --output-format stream-json 不匹配）。

### 假设 4：卡片的流式更新时效性

参考项目每次 `streamAICard` 都等待请求完成（有 `await`），不怕慢。本地项目也是在 `finish()` 里 await 了 streamUpdate。但 100ms 轮询期间，如果 AI 已经完成了（3秒），那只有 1-2 次更新机会。

### 假设 5：钉钉卡片模板本身不支持打字机效果

待验证：模板 `02fcf2f4-5e02-4a85-b672-46d1f715543e.schema` 配合 `flowStatus=2 (INPUTING)` 是否真的能在钉钉客户端渲染"思考中"→"逐字显示"的动画。

---

## 诊断步骤：加日志确认 onText 是否触发

**执行前先备份**：

```bash
cd /Users/scottwang/Documents/Workspace/Dingtalk
cp src/gateway/index.ts src/gateway/index.ts.bak
```

**在 `onText` callback（第 842 行附近）插入诊断日志**：

```bash
sed -i '' '844a\                  console.log(`[Gateway] onText: "${text.substring(0, 80).replace(/"/g, "\\"")}"`);' src/gateway/index.ts
# 也给 onThinking 加一个
sed -i '' '854a\                  console.log(`[Gateway] onThinking: ${text.substring(0, 80)}`);' src/gateway/index.ts
```

**编译部署**：

```bash
npm run build
pm2 restart dingtalk-bot
```

**发消息后查看**：

```bash
pm2 logs dingtalk-bot --lines 200 --nostream 2>&1 | grep "onText\|onThinking\|AICard.*流式更新"
```

**解读**：

- 有 `onText: "xxx"` 日志 → callback 触发了，问题在 appendChunk/DisplayFilter → 从 appendChunk 链路排查
- 无 `onText` 日志 → onText callback 从未被调用 → 根因在 session.ts 的 handleLine() / NDJSON 解析
- 有 `onText` 但无 `AICard.*流式更新` → appendChunk 没触发 → DisplayFilter 过滤掉了

**还原**：

```bash
cp src/gateway/index.ts.bak src/gateway/index.ts
npm run build && pm2 restart dingtalk-bot
```

---

## 已实施代码修改（2026-05-09 16:00）

### 诊断日志已直接注入代码（非 sed方案）

不再依赖手动 sed，在源代码中直接添加了多级诊断日志：

**`src/claude/session.ts`** — NDJSON 解析层：

```typescript
// handleLine(): JSON.parse 之后
console.log(`[Session] handleLine: type=${event.type}`);

// handleAssistantEvent(): 每个 content block 类型都打印
console.log(
  `[Session] handleAssistantEvent: text block, length=${block.text.length}, preview="..."`
);
console.log(`[Session] handleAssistantEvent: thinking block, length=${block.text.length}`);
console.log(`[Session] handleAssistantEvent: tool_use block, name=${block.name}`);
console.log(`[Session] handleAssistantEvent: tool_result block, tool_use_id=${block.tool_use_id}`);

// handleResultEvent(): 请求完成时
console.log(`[Session] handleResultEvent: result.length=X, executionMs=Y`);
```

**`src/gateway/index.ts`** — onText callback（第 842 行附近）：

```typescript
onText: async (text: string) => {
  console.log(`[Gateway] onText callback fired: "${text.substring(0, 80).replace(/"/g, '\\"')}"`);
  const filtered = displayFilter.filter({ type: 'text', content: text });
  if (filtered.shouldSend && filtered.content) {
    console.log(`[Gateway] onText: filtered.shouldSend=true, appending ${filtered.content.length} chars`);
    await streamHandle.appendChunk(filtered.content);
    console.log(`[Gateway] onText: appendChunk done`);
  } else {
    console.log(`[Gateway] onText: filtered.shouldSend=false, skipping`);
  }
},
```

### 其他已实施的修改

1. **`aiCardService.ts`** — 从 createAndDeliver 一步法改为两步 API：
   - `POST /v1.0/card/instances` → 创建卡片实例
   - `POST /v1.0/card/instances/deliver` → 投放卡片到用户/群

2. **`streamingCard.ts`** — 防抖策略改为 `lastSentAt` 时间门控：
   - 100ms 快速轮询间隔（检测时间条件）
   - 首次更新立即触发（`lastSentAt===0`）
   - 后续更新等待 `CARD_UPDATE_INTERVAL=800ms`

3. **`gateway/index.ts`** — 等 `initSessionPool` 预热完成后才启动服务

### 构建和测试验证

```bash
npm run build    # ✅ 通过（505 tests passed）
npm test         # ✅ 505/505 通过，无回归
git add -A && git commit -m "fix: 添加流式诊断日志"
pm2 restart dingtalk-bot
```

---

## 日志解读矩阵（诊断步骤）

发消息后运行：

```bash
pm2 logs dingtalk-bot --lines 300 --nostream 2>&1 | grep -E "(Session.*handle|handleAssistantEvent|Gateway.*onText|AICard.*流式更新|Card updated|appendChunk)"
```

| 日志现象                                                   | 含义                                  | 下一步                                      |
| ---------------------------------------------------------- | ------------------------------------- | ------------------------------------------- |
| 全程无 `[Session] handleLine`                              | CLI stdout 没有数据到达 readline      | 检查 session.ts 的 stdout 连接或 CLI 参数   |
| 有 `handleLine: type=system` 但无 `type=assistant`         | CLI 输出了 init 但不发 assistant 事件 | 检查 `--output-format` 是否为 `stream-json` |
| 有 `handleAssistantEvent: text block`                      | NDJSON 正常解析出 text block          | → 检查 gateway onText                       |
| **无** `[Gateway] onText callback fired`                   | gateway onText 未被调用               | DisplayFilter 或 streamHandle 问题          |
| 有 `[Gateway] onText callback fired` 但也无 `Card updated` | appendChunk 没触发定时刷新器          | streamingCard.ts 逻辑问题                   |
| 有 `Card updated` + `contentLength`                        | 流式更新正常触发                      | 卡片渲染层问题（钉钉客户端）                |

### 关键日志时间线（正常时）

```
15:39:09 [Session] handleLine: type=system           ← CLI 就绪
15:39:09 [Session] handleLine: type=assistant        ← 开始收到内容
15:39:09 [Session] handleAssistantEvent: text block  ← 触发 onText
15:39:09 [Gateway] onText callback fired: "Hello"    ← DisplayFilter 通过
15:39:09 [Gateway] onText: appendChunk done          ← 流式卡片已更新
15:39:09 [StreamingCard] Card updated (lastSentAt gating) ← 卡片 API 成功
15:39:12 [Session] handleResultEvent: result.length=63
```

### 异常日志时间线（当前状态）

```
15:39:09 [Session] handleLine: type=system           ← 只到 init，没有任何 assistant 事件
15:39:09 [Session] 状态: ready → busy
15:39:12 [Session] 状态: busy → ready                ← 直接跳到完成
# ↑ 无任何一个 [Session] handleLine: type=assistant
# ↑ 无任何一个 [Gateway] onText callback fired
```

---

## 下一步行动

1. ✅ **诊断日志已注入** → 运行 `pm2 logs` 确认根因方向
2. ⏳ **观察 `handleLine: type=` 的输出** → 若只有 system → CLI 输出格式问题
3. ⏳ **跑 session.test.ts**：验证 handleLine 的 NDJSON 解析逻辑本身正常
4. ⏳ **发送长消息（>1000 字符）测试**：看是否有多个中间更新
5. ⏳ **用户需手动 git push**：上次 commit 的改动还未推送到远程

---

## 文件位置索引

- `src/gateway/index.ts` — 流式 callback 注册（行 775-907）
- `src/claude/executor.ts` — executeSession（行 596-641）
- `src/claude/sessionPool.ts` — send() 调用（行 106-128）
- `src/claude/session.ts` — NDJSON 解析 + callback 触发（行 475-566）
- `src/dingtalk/aiCardService.ts` — Token API + 两步创建
- `src/dingtalk/streamingCard.ts` — 防抖逻辑 + finish
- `src/display/DisplayFilter.ts` — ANSI/控制消息过滤
