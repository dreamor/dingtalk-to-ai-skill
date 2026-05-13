# 项目健康检查报告

**日期**: 2026-05-13
**版本**: v1.5.0
**技术栈**: TypeScript + Express + better-sqlite3 + 钉钉 Stream SDK

---

## 总体评估

| 维度       | 评分 | 状态                          |
| ---------- | ---- | ----------------------------- |
| 安全       | B+   | 良好（内部服务有 Token 保护） |
| 代码质量   | B-   | 需改进                        |
| 测试覆盖率 | D    | 不达标（目标 60%）            |
| 架构       | B    | 良好                          |
| 性能       | B    | 良好                          |
| 依赖       | A    | 良好                          |

---

## P0 - 必须修复

### P0-1: `as any` 类型断言绕过类型安全

**问题**: 8 处 `as any` 类型断言绕过 TypeScript 检查，可能隐藏运行时错误。

**具体位置**:

- `src/scheduler/scheduler.ts:107,130,187,312` — 4 处 `(this.storage as any).db` 访问私有属性
- `src/agents/adapters/claude.ts:16` — `options as any`
- `src/agents/adapters/opencode.ts:16` — `options as any`
- `src/index.ts:166` — `ruleConfig.condition as any`
- `src/hooks/hookRunner.ts:64,107` — action 类型断言

**建议修复**:

1. `scheduler.ts`: 为 Storage 类添加 `getDb()` 访问器方法或暴露 `executeDb()` 方法
2. `adapters`: 定义 `ExecutorOptions` 接口替代 `any`
3. `hookRunner.ts`: 使用 discriminated union 替代 `as any`

**预估工作量**: 1 天

### P0-2: `console.log` 替换为结构化日志

**问题**: 项目中有 247 处 `console.log/debug` 调用。生产环境无法按级别过滤、无法结构化查询、无法静默低级别日志。

**影响范围**: 全部 `src/` 模块

**建议修复**:

1. 已有 `src/utils/logger.ts` 和 `src/logger/index.ts`，但仅部分模块使用
2. 全局替换 `console.log` → `logger.info`，`console.error` → `logger.error`，`console.warn` → `logger.warn`
3. 统一日志格式：`[模块名] action: data`
4. 移除调试用 `console.log`（如 `[Gateway] onText callback fired` 这类高频日志）

**预估工作量**: 2 天

---

## P1 - 应当修复

### P1-1: API 路由输入验证增强

**问题**: 多个 API 端点有必填字段检查，但缺少类型和格式验证。项目 API 有 `GATEWAY_API_TOKEN` 保护，非公网暴露，风险可控。

**需要增强的验证**:

1. **cron 格式校验** — `schedulerRoutes.ts` 的 `cron` 字段应验证合法 cron 表达式，防止无效 cron 导致 scheduler 异常
2. **数值范围校验** — `timeout`、`limit`、`offset` 确保为正整数，防止负数或超大值
3. **`req.params.id` 格式检查** — delete/patch 路由的 `:id` 应验证为合法 ID 格式

**不需要做的**:

- 引入 Zod schema 全量验证（现有 `if (!xxx)` 必填检查对内网服务够用）
- 对所有 req.body 做完整 schema 验证

**预估工作量**: 0.5 天

### P1-2: `gateway/index.ts` 文件过大 (1070 行)

**问题**: `GatewayServer` 类承担消息处理、流式卡片、重试、消费者循环、session 管理、命令路由等多重职责，违反单一职责原则。

**建议修复**:

1. 将 `processMessageInternal()` 提取到 `MessageProcessor` 类
2. 将流式卡片回调逻辑提取到 `StreamingCallbacks` 类
3. 将 `createMarkdownSender` / `createTextSender` 提取到共用模块
4. 目标: GatewayServer < 300 行，仅负责路由编排

**预估工作量**: 3 天

### P1-3: 测试覆盖率提升至 60%

**当前覆盖率**:

| 模块             | 行覆盖率 | 分支覆盖率 | 函数覆盖率 |
| ---------------- | -------- | ---------- | ---------- |
| agents/          | 0%       | 0%         | 0%         |
| claude/          | 21.8%    | 12.2%      | 28.4%      |
| display/         | 9.8%     | 0%         | 0%         |
| gateway/routes/  | 23%      | 0%         | 22.9%      |
| health/          | 9.2%     | 0%         | 13.3%      |
| hooks/           | 16.7%    | 0%         | 5.9%       |
| opencode/        | 27.4%    | 11.9%      | 33.3%      |
| session-manager/ | 43.3%    | 30%        | 44.4%      |
| dingtalk/        | 39%      | 31.4%      | 49.5%      |

**聚焦关键路径**（不追 adapter 和 route 层的覆盖率数字）:

1. 消息处理核心链路（queue → consumer → executor）
2. 会话管理（TTL、轮转、持久化）
3. 配置验证和边界条件
4. 错误处理路径（重试、降级）

**预估工作量**: 3-4 天

### P1-4: 静默吞噬错误（`.catch(() => {})` 模式）

**问题**: 10 处 `.catch(() => {})` 完全吞掉错误，导致调试困难。

**具体位置**:

- `src/index.ts:345,355,370,383` — 进程信号处理和全局错误处理器
- `src/memory/memoryManager.ts:152` — 自动摘要失败
- `src/utils/alert.ts:81,104` — 告警发送失败
- `src/gateway/index.ts:414,494` — Hook 触发失败
- `src/gateway/queueConsumer.ts:284` — Hook 触发失败

**建议修复**:

1. 至少用 `logger.warn` 记录错误信息
2. 对关键路径（如全局错误处理器）添加降级日志
3. 对 hook 触发添加 `logger.debug` 级别记录

**预估工作量**: 0.5 天

### P1-5: 空 `catch` 块（无错误变量的 try-catch）

**问题**: 20+ 处 `catch {}` 或 `catch { return ... }` 未记录错误信息。

**关键位置**:

- `src/claude/session.ts` — 5 处空 catch，会话管理关键路径
- `src/claude/proxyClient.ts` — 3 处空 catch
- `src/claude/executor.ts` — 2 处空 catch
- `src/config.ts:310,330,338` — JSON.parse 失败时静默返回空数组
- `src/storage/sqlite.ts:622` — 数据库操作失败

**建议修复**: 统一添加 `logger.warn/error` 记录，至少保留 `console.error`

**预估工作量**: 1 天

### P1-6: ESLint suppressions 过多（74 处）

**分类**:

- `@typescript-eslint/no-misused-promises`: 16 处 — Express 路由使用 async handler
- `@typescript-eslint/no-unsafe-assignment`: 15 处 — 外部数据未类型化
- `@typescript-eslint/require-await`: 14 处 — async 函数中无 await
- `@typescript-eslint/no-unsafe-member-access`: 11 处
- `@typescript-eslint/no-explicit-any`: 7 处

**建议修复**:

1. 为 Express 路由创建 `asyncHandler` 包装函数解决 `no-misused-promises`
2. 为钉钉 API 响应定义接口类型，减少 `unsafe-*`
3. 移除不必要的 `async` 修饰符解决 `require-await`
4. 目标: 减少 suppressions 到 < 20 处

**预估工作量**: 2 天

### P1-7: `dangerously-skip-permissions` 权限模式

**问题**: `config.ts:256-261` 允许通过环境变量设置 `dangerously-skip-permissions`。如果部署时意外设置此值，AI CLI 可无限制执行任意命令。

**建议修复**:

1. 启动时检测此模式并打印醒目警告
2. 在生产环境（`NODE_ENV=production`）禁用此模式
3. 添加启动时强制确认（至少日志级）
4. 考虑添加二次验证（需要额外环境变量确认）

**预估工作量**: 0.5 天

---

## P2 - 建议改进

### P2-1: Map 缓存可能无限增长

**问题**: 多个 Map 缓存虽有清理逻辑，但运行异常时清理可能失效。

**关键位置**:

- `src/dingtalk/streamingCard.ts:133` — `streams: Map<string, ActiveStream>` — 已有定时清理但依赖 `setInterval`
- `src/claude/proxyClient.ts:115` — `toolUseMap: Map<string, ToolUseInfo>` — 仅在 `disconnect` 时 clear
- `src/claude/proxyExecutor.ts:59` — `sessions: Map<string, ActiveSession>` — 需确认过期清理
- `src/utils/cliChecker.ts:9` — `availabilityCache: Map` — 无过期时间，永久缓存
- `src/message-queue/rateLimiter.ts:15` — `buckets: Map<string, UserBucket>` — 同上

**建议**: 为长期缓存的 Map 添加 LRU 或 TTL 机制

**预估工作量**: 1 天

### P2-2: `scheduler.ts` 访问 Storage 私有属性

**问题**: `scheduler.ts` 通过 `(this.storage as any).db` 绕过封装直接操作 SQLite，破坏了 `Storage` 类的封装边界。

**建议**: 在 Storage 类中暴露 `executeInTransaction(fn)` 或 `run(sql, params)` 方法

**预估工作量**: 0.5 天

### P2-3: 缺少请求限流（Rate Limiting）中间件

**问题**: 虽然 `RateLimiter` 类存在，但仅用于消息队列粒度。HTTP API 端点（`/api/*`）缺少请求限流，可能被暴力调用。

**建议**: 添加 `express-rate-limit` 中间件保护所有 `/api/*` 路由

**预估工作量**: 0.5 天

### P2-4: `config.ts` 中 `JSON.parse` 无 schema 验证

**问题**: `SCHEDULER_TASKS`、`ROUTER_PROVIDERS`、`ROUTER_RULES` 三个环境变量是 `JSON.parse` 解析的，但仅做了 `catch { return [] }`，不验证结构。恶意格式的 JSON 可能导致后续运行时错误。

**建议**: 使用 Zod 定义对应的 schema 对解析后的结果验证

**预估工作量**: 0.5 天

### P2-5: 依赖版本偏旧

**需关注**:

| 包         | 当前   | 最新   | 风险                 |
| ---------- | ------ | ------ | -------------------- |
| express    | 4.22.1 | 5.2.1  | 主版本落后，安全补丁 |
| jest       | 29.7.0 | 30.4.2 | 主版本落后           |
| typescript | 5.9.3  | 6.0.3  | 主版本落后           |
| dotenv     | 16.6.1 | 17.4.2 | 主版本落后           |
| @eslint/js | 9.39.4 | 10.0.1 | 主版本落后           |

**建议**: 优先升级 `express` 和 `dotenv`（安全相关），`jest` 和 `typescript` 可在后续迭代中升级

**预估工作量**: 2-3 天

### P2-6: `proxyClient.ts` 使用自建日志而非统一 logger

**问题**: `src/claude/proxyClient.ts:22-33` 定义了自己的 `log()` 函数和 `logger` 对象，不使用项目统一的 `createSafeLogger`。

**建议**: 替换为 `createSafeLogger('ClaudeProxyClient')`

**预估工作量**: 0.5 天

### ~~P2-7: Jest 测试进程未正常退出~~ ✅ 已修复

已在 2026-05-13 修复：12 个 open handle 降为 0，506 测试正常退出。

---

## 改进路线图

### 第一阶段: 类型安全 + 日志（1 周）

| 编号 | 任务                     | 优先级 | 工作量 |
| ---- | ------------------------ | ------ | ------ |
| P0-1 | 消除 `as any` 类型断言   | P0     | 1 天   |
| P0-2 | console.log → 结构化日志 | P0     | 2 天   |
| P1-4 | 修复静默错误吞噬         | P1     | 0.5 天 |
| P1-5 | 修复空 catch 块          | P1     | 1 天   |

### 第二阶段: 代码质量（1 周）

| 编号 | 任务                                     | 优先级 | 工作量 |
| ---- | ---------------------------------------- | ------ | ------ |
| P1-1 | API 输入验证增强（cron 格式 + 数值范围） | P1     | 0.5 天 |
| P1-7 | 限制 `dangerously-skip-permissions`      | P1     | 0.5 天 |
| P1-6 | 减少 ESLint suppressions                 | P1     | 2 天   |
| P1-2 | 拆分 GatewayServer                       | P1     | 3 天   |

### 第三阶段: 测试覆盖率（1.5 周）

| 编号  | 任务                              | 优先级 | 工作量 |
| ----- | --------------------------------- | ------ | ------ |
| P1-3a | 消息处理核心链路测试              | P1     | 1.5 天 |
| P1-3b | 会话管理测试（TTL、轮转、持久化） | P1     | 1 天   |
| P1-3c | 配置验证和边界条件测试            | P1     | 0.5 天 |
| P1-3d | 错误处理路径测试（重试、降级）    | P1     | 1 天   |

### 第四阶段: 架构优化（1 周）

| 编号 | 任务                        | 优先级 | 工作量 |
| ---- | --------------------------- | ------ | ------ |
| P2-1 | Map 缓存 TTL/LRU 机制       | P2     | 1 天   |
| P2-2 | Storage 封装改进            | P2     | 0.5 天 |
| P2-3 | API 请求限流中间件          | P2     | 0.5 天 |
| P2-4 | JSON 环境变量 schema 验证   | P2     | 0.5 天 |
| P2-6 | 统一 proxyClient 日志       | P2     | 0.5 天 |
| P2-5 | 依赖升级（express, dotenv） | P2     | 2-3 天 |

---

## 优秀实践（值得保留）

1. **配置集中管理**: `config.ts` 带值域验证，类型安全
2. **消息队列架构**: 去重 + 限流 + 并发控制，完整的生产级模式
3. **模块化拆分**: 路由已按功能拆分到 `routes/` 目录
4. **错误格式化**: 独立的 `errorFormatter.ts` 模块
5. **流式卡片降级**: 完整的 AI Card → Markdown 降级路径
6. **持久化会话池**: 消除冷启动延迟
7. **TypeScript 严格模式**: 编译零错误
8. **测试 506 用例全通过**: 无回归
9. **零安全漏洞**: `npm audit` 清洁
10. **DedupCache**: 带 TTL 的去重缓存设计合理
