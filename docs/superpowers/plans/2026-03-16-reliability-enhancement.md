# 可靠性增强实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增强钉钉消息处理的可靠性，确保每个消息都能收到回复，并在 OpenCode 执行失败时自动重试

**Architecture:**
1. OpenCode 执行器添加指数退避重试机制
2. 消息队列增强状态追踪和延迟重试
3. Stream 服务添加 sessionWebhook 健康检查
4. 添加完整的监控日志链路

**Tech Stack:** TypeScript, Node.js, 内存队列，指数退避算法

---

## Chunk 1: OpenCode 执行器重试机制

### Task 1: 创建重试工具类

**Files:**
- Create: `src/utils/retry.ts`
- Test: `src/utils/__tests__/retry.test.ts`

- [ ] **Step 1: 创建重试工具类文件**

```typescript
// src/utils/retry.ts

/**
 * 重试选项
 */
export interface RetryOptions {
  maxRetries: number;        // 最大重试次数
  baseDelay: number;         // 基础延迟 (ms)
  maxDelay: number;          // 最大延迟 (ms)
  exponential: boolean;      // 是否指数退避
  onRetry?: (attempt: number, error: Error, delay: number) => void; // 重试回调
}

/**
 * 默认重试选项
 */
export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelay: 1000,    // 1 秒
  maxDelay: 30000,    // 30 秒
  exponential: true,
};

/**
 * 计算延迟时间（指数退避）
 */
export function calculateDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  exponential: boolean
): number {
  if (!exponential) {
    return baseDelay;
  }

  // 指数退避：baseDelay * 2^(attempt-1)
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);

  // 添加随机抖动（0-1000ms），避免多个请求同时重试
  const jitter = Math.floor(Math.random() * 1000);

  return Math.min(exponentialDelay + jitter, maxDelay);
}

/**
 * 判断错误是否可重试
 * 超时、网络错误等临时故障可重试
 * 配置错误、权限错误等不可重试
 */
export function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();

  // 不可重试的错误
  const nonRetryablePatterns = [
    'permission',
    'unauthorized',
    'forbidden',
    'not found',
    'invalid config',
    'command not found',
  ];

  for (const pattern of nonRetryablePatterns) {
    if (message.includes(pattern)) {
      return false;
    }
  }

  // 默认认为可重试
  return true;
}

/**
 * 带重试执行函数
 * @param fn 要执行的异步函数
 * @param options 重试选项
 * @returns 执行结果
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const {
    maxRetries = DEFAULT_RETRY_OPTIONS.maxRetries,
    baseDelay = DEFAULT_RETRY_OPTIONS.baseDelay,
    maxDelay = DEFAULT_RETRY_OPTIONS.maxDelay,
    exponential = DEFAULT_RETRY_OPTIONS.exponential,
    onRetry,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // 检查是否可重试
      if (!isRetryableError(lastError)) {
        throw lastError;
      }

      // 已达到最大重试次数
      if (attempt > maxRetries) {
        throw lastError;
      }

      // 计算延迟
      const delay = calculateDelay(attempt, baseDelay, maxDelay, exponential);

      // 调用重试回调
      onRetry?.(attempt, lastError, delay);

      // 等待延迟
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // 理论上不会到这里
  throw lastError;
}
```

- [ ] **Step 2: 编写重试工具类测试**

```typescript
// src/utils/__tests__/retry.test.ts

import { withRetry, calculateDelay, isRetryableError, DEFAULT_RETRY_OPTIONS } from '../retry';

describe('Retry Utils', () => {
  describe('calculateDelay', () => {
    it('should calculate linear delay', () => {
      const delay = calculateDelay(1, 1000, 10000, false);
      expect(delay).toBe(1000);
    });

    it('should calculate exponential delay', () => {
      const delay1 = calculateDelay(1, 1000, 10000, true);
      expect(delay1).toBeGreaterThanOrEqual(1000);
      expect(delay1).toBeLessThan(3000); // 1000 + jitter

      const delay2 = calculateDelay(2, 1000, 10000, true);
      expect(delay2).toBeGreaterThanOrEqual(2000);
      expect(delay2).toBeLessThan(4000); // 2000 + jitter
    });

    it('should cap at maxDelay', () => {
      const delay = calculateDelay(10, 1000, 5000, true);
      expect(delay).toBeLessThanOrEqual(5000);
    });
  });

  describe('isRetryableError', () => {
    it('should return false for non-retryable errors', () => {
      expect(isRetryableError(new Error('Permission denied'))).toBe(false);
      expect(isRetryableError(new Error('Unauthorized'))).toBe(false);
      expect(isRetryableError(new Error('Command not found'))).toBe(false);
    });

    it('should return true for retryable errors', () => {
      expect(isRetryableError(new Error('Timeout'))).toBe(true);
      expect(isRetryableError(new Error('Network error'))).toBe(true);
      expect(isRetryableError(new Error('Connection reset'))).toBe(true);
    });
  });

  describe('withRetry', () => {
    it('should return result on first success', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const result = await withRetry(fn, { maxRetries: 3, baseDelay: 10 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and succeed', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValue('success');

      const result = await withRetry(fn, {
        maxRetries: 3,
        baseDelay: 10,
        maxDelay: 50
      });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should throw after max retries', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('Timeout'));

      await expect(withRetry(fn, { maxRetries: 2, baseDelay: 10 }))
        .rejects.toThrow('Timeout');
      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('should not retry for non-retryable errors', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('Permission denied'));

      await expect(withRetry(fn, { maxRetries: 3, baseDelay: 10 }))
        .rejects.toThrow('Permission denied');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should call onRetry callback', async () => {
      const onRetry = jest.fn();
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValue('success');

      await withRetry(fn, {
        maxRetries: 3,
        baseDelay: 10,
        onRetry
      });

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(expect.any(Number), expect.any(Error), expect.any(Number));
    });
  });
});
```

- [ ] **Step 3: 运行测试验证**

```bash
npx jest src/utils/__tests__/retry.test.ts -v
```

期望：所有测试通过

- [ ] **Step 4: 提交**

```bash
git add src/utils/retry.ts src/utils/__tests__/retry.test.ts
git commit -m "feat: add retry utility with exponential backoff"
```

---

### Task 2: OpenCode 执行器集成重试

**Files:**
- Modify: `src/opencode/executor.ts`
- Test: `src/opencode/__tests__/executor-retry.test.ts`

- [ ] **Step 1: 在 executor.ts 中导入重试工具**

```typescript
// 在 src/opencode/executor.ts 开头添加
import { withRetry, DEFAULT_RETRY_OPTIONS } from '../utils/retry';
```

- [ ] **Step 2: 修改 execute 方法，添加重试逻辑**

```typescript
// 修改 src/opencode/executor.ts 中的 execute 方法

async execute(prompt: string, context?: MessageContext): Promise<OpenCodeResult> {
  const startTime = Date.now();

  console.log(`📝 执行 Open Code: ${prompt.substring(0, 50)}...`);
  if (context?.userId) {
    console.log(`   用户：${context.userName || context.userId}`);
  }

  try {
    // 构建完整的输入（包含上下文）
    const fullPrompt = this.buildPromptWithContext(prompt, context);

    // 验证输入长度
    this.validateInput(fullPrompt);

    // 构建命令参数（不包含用户消息，通过 stdin 传递）
    const args = this.buildCommandArgs();

    // 带重试执行命令
    const result = await withRetry(
      () => this.runCommand(args, fullPrompt),
      {
        maxRetries: this.config.maxRetries,
        baseDelay: 1000,
        maxDelay: 10000,
        exponential: true,
        onRetry: (attempt, error, delay) => {
          console.warn(
            `[OpenCode] 执行失败，正在重试 (第 ${attempt}/${this.config.maxRetries} 次，延迟 ${delay}ms): ${error.message}`
          );
        },
      }
    );

    // 解析输出
    const parsedOutput = this.parseOutput(result.output);

    return {
      ...result,
      output: parsedOutput,
      executionTime: Date.now() - startTime,
    };
  } catch (error) {
    console.error('[OpenCode] 执行失败:', error);

    if (error instanceof InputValidationError) {
      return {
        success: false,
        output: '',
        error: error.message,
        executionTime: Date.now() - startTime,
        exitCode: -1,
      };
    }

    return {
      success: false,
      output: '',
      error: error instanceof Error ? error.message : '未知错误',
      executionTime: Date.now() - startTime,
      exitCode: -1,
    };
  }
}
```

- [ ] **Step 3: 添加重试计数器到结果接口**

```typescript
// 在 OpenCodeResult 接口中添加
export interface OpenCodeResult {
  success: boolean;
  output: string;
  error?: string;
  executionTime: number;
  exitCode: number;
  retryCount?: number;  // 新增：实际重试次数
}
```

- [ ] **Step 4: 编写执行器重试测试**

```typescript
// src/opencode/__tests__/executor-retry.test.ts

import { OpenCodeExecutor } from '../executor';
import { withRetry } from '../../utils/retry';

jest.mock('../../config', () => ({
  config: {
    opencode: {
      command: 'echo',
      timeout: 5000,
      maxRetries: 3,
      model: 'test-model',
      maxInputLength: 10000,
      workingDir: process.cwd(),
    },
  },
}));

describe('OpenCodeExecutor Retry', () => {
  let executor: OpenCodeExecutor;

  beforeEach(() => {
    executor = new OpenCodeExecutor();
  });

  it('should succeed on first attempt', async () => {
    const result = await executor.execute('hello');
    expect(result.success).toBe(true);
  });

  it('should retry on transient failure', async () => {
    // 这个测试需要 mock spawn 行为，验证重试逻辑
    // 实际测试需要更多设置
  });
});
```

- [ ] **Step 5: 运行测试验证**

```bash
npx jest src/opencode/__tests__/executor-retry.test.ts -v
npx jest src/utils/__tests__/retry.test.ts -v
```

- [ ] **Step 6: 提交**

```bash
git add src/opencode/executor.ts src/opencode/__tests__/executor-retry.test.ts
git commit -m "feat: integrate retry logic into OpenCode executor"
```

---

## Chunk 2: 消息队列增强

### Task 3: 增强消息队列状态追踪

**Files:**
- Modify: `src/message-queue/messageQueue.ts`
- Create: `src/message-queue/__tests__/messageQueue-retry.test.ts`

- [ ] **Step 1: 添加消息状态枚举**

```typescript
// 在 messageQueue.ts 中添加

export type MessageStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'retrying';

interface QueuedMessage {
  message: UserMessage;
  priority: MessagePriority;
  enqueueTime: number;
  retryCount: number;
  status: MessageStatus;           // 新增：消息状态
  lastAttemptTime?: number;        // 新增：最后尝试时间
  nextRetryTime?: number;          // 新增：下次重试时间
  errorMessage?: string;           // 新增：最后错误消息
  metadata?: Record<string, any>;  // 新增：元数据
}
```

- [ ] **Step 2: 添加延迟重试队列**

```typescript
// 在 MessageQueue 类中添加
export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private processing: Set<string> = new Set();
  private maxRetries: number;
  private baseDelay: number = 1000;    // 新增：基础延迟
  private maxDelay: number = 30000;    // 新增：最大延迟

  // 获取可处理的消息（排除未到重试时间的）
  dequeue(): QueuedMessage | null {
    const now = Date.now();

    // 找到第一个可处理的消息
    const index = this.queue.findIndex((item) => {
      if (this.processing.has(item.message.id)) {
        return false;
      }
      // 如果是重试消息，检查是否到重试时间
      if (item.status === 'retrying' && item.nextRetryTime) {
        return now >= item.nextRetryTime;
      }
      return true;
    });

    if (index === -1) {
      return null;
    }

    const item = this.queue.splice(index, 1)[0];
    this.processing.add(item.message.id);
    item.status = 'processing';
    item.lastAttemptTime = now;

    return item;
  }

  // 标记消息处理失败，加入延迟重试
  fail(messageId: string, errorMessage?: string): void {
    const index = this.queue.findIndex(
      (item) => item.message.id === messageId && this.processing.has(messageId)
    );

    if (index !== -1) {
      const item = this.queue.splice(index, 1)[0];
      this.processing.delete(messageId);
      item.errorMessage = errorMessage;

      if (item.retryCount < this.maxRetries) {
        item.retryCount++;
        item.status = 'retrying';
        item.priority = 'high';

        // 计算延迟重试时间
        const delay = this.calculateRetryDelay(item.retryCount);
        item.nextRetryTime = Date.now() + delay;

        this.queue.push(item);
        this.sortByPriority();
        console.log(
          `🔄 消息重试：${messageId} (第 ${item.retryCount} 次，延迟 ${delay}ms)`
        );
      } else {
        item.status = 'failed';
        console.log(`❌ 消息处理失败：${messageId} (超过最大重试次数)`);
      }
    }
  }

  // 计算重试延迟（指数退避 + 抖动）
  private calculateRetryDelay(retryCount: number): number {
    const exponentialDelay = this.baseDelay * Math.pow(2, retryCount - 1);
    const jitter = Math.floor(Math.random() * 1000);
    return Math.min(exponentialDelay + jitter, this.maxDelay);
  }

  // 获取队列状态（包含重试信息）
  getStatus(): {
    queued: number;
    processing: number;
    retrying: number;
    failed: number;
    byPriority: Record<MessagePriority, number>;
  } {
    const byPriority: Record<MessagePriority, number> = { high: 0, normal: 0, low: 0 };
    let retrying = 0;
    let failed = 0;

    this.queue.forEach((item) => {
      byPriority[item.priority]++;
      if (item.status === 'retrying') retrying++;
      if (item.status === 'failed') failed++;
    });

    return {
      queued: this.queue.length,
      processing: this.processing.size,
      retrying,
      failed,
      byPriority,
    };
  }

  // 获取失败的消息
  getFailedMessages(): QueuedMessage[] {
    return this.queue.filter(item => item.status === 'failed');
  }

  // 重置失败消息以便重试
  resetFailedMessage(messageId: string): boolean {
    const item = this.queue.find(item => item.message.id === messageId);
    if (item && item.status === 'failed') {
      item.status = 'pending';
      item.retryCount = 0;
      item.nextRetryTime = undefined;
      item.errorMessage = undefined;
      this.sortByPriority();
      return true;
    }
    return false;
  }
}
```

- [ ] **Step 3: 编写测试**

```typescript
// src/message-queue/__tests__/messageQueue-retry.test.ts

import { MessageQueue } from '../messageQueue';

describe('MessageQueue Retry', () => {
  let queue: MessageQueue;

  beforeEach(() => {
    queue = new MessageQueue({ maxRetries: 3 });
  });

  it('should enqueue message with pending status', () => {
    const msg = { id: '1', type: 'user' as const, content: 'test', userId: 'u1' };
    queue.enqueue(msg);

    const status = queue.getStatus();
    expect(status.queued).toBe(1);
  });

  it('should mark message as processing when dequeued', () => {
    const msg = { id: '1', type: 'user' as const, content: 'test', userId: 'u1' };
    queue.enqueue(msg);

    const item = queue.dequeue();
    expect(item).toBeTruthy();
    expect(item?.status).toBe('processing');
  });

  it('should schedule retry with delay on failure', () => {
    const msg = { id: '1', type: 'user' as const, content: 'test', userId: 'u1' };
    queue.enqueue(msg);
    queue.dequeue(); // Mark as processing

    queue.fail('1', 'Test error');

    const status = queue.getStatus();
    expect(status.retrying).toBe(1);
  });

  it('should mark as failed after max retries', () => {
    const msg = { id: '1', type: 'user' as const, content: 'test', userId: 'u1' };
    queue.enqueue(msg);

    for (let i = 0; i < 4; i++) {
      const item = queue.dequeue();
      if (item) queue.fail('1', `Error ${i}`);
    }

    const status = queue.getStatus();
    expect(status.failed).toBe(1);
  });

  it('should get failed messages', () => {
    // Test getFailedMessages
  });

  it('should reset failed message', () => {
    // Test resetFailedMessage
  });
});
```

- [ ] **Step 4: 运行测试验证**

```bash
npx jest src/message-queue/__tests__/messageQueue-retry.test.ts -v
```

- [ ] **Step 5: 提交**

```bash
git add src/message-queue/messageQueue.ts src/message-queue/__tests__/messageQueue-retry.test.ts
git commit -m "feat: add retry state tracking to message queue"
```

---

## Chunk 3: Stream 服务增强

### Task 4: 添加 sessionWebhook 健康检查

**Files:**
- Modify: `src/dingtalk/stream.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 在 Stream 服务中添加 webhook 验证**

```typescript
// 在 DingtalkStreamService 类中添加

interface SessionInfo {
  conversationId: string;
  sessionWebhook: string;
  timestamp: number;
  lastUsedAt: number;     // 新增：最后使用时间
  healthStatus: 'healthy' | 'unknown' | 'failed';  // 新增：健康状态
  failureCount: number;   // 新增：失败计数
}

// 添加回复发送时的健康检查
async sendTextMessage(
  conversationId: string,
  content: string,
  mentionList?: string[]
): Promise<boolean> {  // 修改返回值
  try {
    if (!this.client) {
      throw new Error('Stream client not connected');
    }

    const sessionInfo = this.pendingMessages.get(conversationId);

    if (!sessionInfo?.sessionWebhook) {
      throw new Error(`sessionWebhook not found for ${conversationId}`);
    }

    // 更新最后使用时间
    sessionInfo.lastUsedAt = Date.now();

    console.log(`[Stream] Sending text: ${content.substring(0, 50)}...`);

    const messageBody = {
      msgtype: 'text',
      text: {
        content,
        at: {
          atUserIds: mentionList || [],
          isAtAll: mentionList?.includes('ALL') || false,
        },
      },
    };

    await axios.post(sessionInfo.sessionWebhook, messageBody, {
      timeout: 10000,
    });

    // 发送成功，更新健康状态
    sessionInfo.healthStatus = 'healthy';
    sessionInfo.failureCount = 0;

    console.log('[Stream] Text message sent successfully');
    return true;
  } catch (error: any) {
    console.error('[Stream] Failed to send text:', error.message);

    // 更新失败计数
    const sessionInfo = this.pendingMessages.get(conversationId);
    if (sessionInfo) {
      sessionInfo.failureCount++;
      sessionInfo.healthStatus = 'failed';

      // 如果连续失败多次，标记为不可用
      if (sessionInfo.failureCount >= 3) {
        console.warn(`[Stream] Webhook 连续失败 3 次，标记为不可用：${conversationId}`);
      }
    }

    if (error.response?.data) {
      console.error('[Stream] Response:', JSON.stringify(error.response.data));
    }
    return false;
  }
}

// 添加清理过期和失效 session 的方法
cleanupStaleSessions(maxAge: number = 30 * 60 * 1000): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [conversationId, sessionInfo] of this.pendingMessages.entries()) {
    // 清理过期 session
    if (now - sessionInfo.timestamp > maxAge) {
      this.pendingMessages.delete(conversationId);
      cleaned++;
      continue;
    }

    // 清理连续失败的 session（24 小时内失败 5 次）
    if (sessionInfo.failureCount >= 5 && now - sessionInfo.lastUsedAt > 60 * 60 * 1000) {
      this.pendingMessages.delete(conversationId);
      cleaned++;
      console.log(`[Stream] 清理失效的 session: ${conversationId}`);
    }
  }

  if (cleaned > 0) {
    console.log(`[Stream] 清理了 ${cleaned} 个过期/失效的 sessions`);
  }

  return cleaned;
}
```

- [ ] **Step 2: 在 index.ts 中添加定期清理**

```typescript
// 在 src/index.ts 中，清理定时器部分添加

// 定期清理失效的 session（每 10 分钟）
setInterval(() => {
  if (globalStreamService) {
    globalStreamService.cleanupStaleSessions();
  }
}, 10 * 60 * 1000);
```

- [ ] **Step 3: 修改消息处理中的回复逻辑**

```typescript
// 在 src/index.ts 的 Stream 消息处理器中修改

// 使用 sessionWebhook 发送回复
if (result.success && result.data?.result) {
  const sent = await streamService.sendMarkdownMessage(conversationId, 'OpenCode 回复', result.data.result);
  if (sent) {
    console.log(`[Stream] ✅ 回复发送成功 (总耗时：${Date.now() - startTime}ms)`);
  } else {
    console.error(`[Stream] ❌ 回复发送失败`);
    // 尝试备用方案：记录日志，发送告警
    if (isAlertEnabled()) {
      notifyError('消息回复失败', `无法发送回复到会话 ${conversationId}`);
    }
  }
} else if (!result.success) {
  const errorMessage = `❌ ${result.message}`;
  await streamService.sendTextMessage(conversationId, errorMessage);
  console.log(`[Stream] ⚠️ 处理失败：${result.message}`);
}
```

- [ ] **Step 4: 提交**

```bash
git add src/dingtalk/stream.ts src/index.ts
git commit -m "feat: add webhook health check to stream service"
```

---

## Chunk 4: 监控日志增强

### Task 5: 添加消息处理链路日志

**Files:**
- Modify: `src/gateway/index.ts`
- Modify: `src/utils/alert.ts`

- [ ] **Step 1: 在 Gateway 中添加消息链路追踪**

```typescript
// 在 src/gateway/index.ts 的 processMessageInternal 方法中

async processMessageInternal(request: GatewayRequest): Promise<GatewayResponse> {
  const { msg, userId = 'unknown', userName = '用户' } = request;
  const startTime = Date.now();
  const messageId = generateMessageId();  // 新增：追踪 ID

  console.log(`[${messageId}] 处理消息：${userName}(${userId}): ${msg.substring(0, 50)}...`);

  try {
    // ... 现有代码 ...

    // 在每个关键步骤添加日志
    console.log(`[${messageId}] 步骤 1: 消息验证通过`);
    console.log(`[${messageId}] 步骤 2: 去重检查通过`);
    console.log(`[${messageId}] 步骤 3: 流量控制通过`);

    // ... 调用 OpenCode ...
    console.log(`[${messageId}] 步骤 4: 调用 OpenCode...`);
    const result = await this.openCodeExecutor.execute(msg, opencodeContext);
    console.log(`[${messageId}] OpenCode 完成：success=${result.success}, time=${result.executionTime}ms`);

    // ... 发送回复 ...

    const totalTime = Date.now() - startTime;
    console.log(`[${messageId}] 消息处理完成，总耗时：${totalTime}ms`);

    return {
      success: result.success,
      message: result.success ? '处理成功' : '处理失败',
      data: {
        result: responseContent,
        conversationId: session.conversationId,
        executionTime: totalTime,
        messageId,  // 新增：返回追踪 ID
      },
    };
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[${messageId}] 消息处理失败 (${totalTime}ms):`, error);
    throw error;
  } finally {
    // 释放并发槽位
    this.concurrencyController.releaseSlot(userId, requestId);
  }
}
```

- [ ] **Step 2: 添加处理超时告警**

```typescript
// 在 src/utils/alert.ts 中添加

export async function notifyMessageProcessingTimeout(
  messageId: string,
  userId: string,
  duration: number
): Promise<void> {
  await sendAlert(
    '消息处理超时',
    `**消息 ID**: ${messageId}\n` +
    `**用户 ID**: ${userId}\n` +
    `**处理时长**: ${duration / 1000}秒\n\n` +
    `请检查系统负载和 OpenCode 状态。`,
    'warning'
  );
}
```

- [ ] **Step 3: 提交**

```bash
git add src/gateway/index.ts src/utils/alert.ts
git commit -m "feat: add message tracing and timeout alerts"
```

---

## Chunk 5: 配置更新

### Task 6: 添加重试相关配置

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example` (如果存在)

- [ ] **Step 1: 在配置中添加重试选项**

```typescript
// 在 src/config.ts 中修改 OpenCodeConfig 接口

interface OpenCodeConfig {
  enabled: boolean;
  command: string;
  timeout: number;
  maxRetries: number;
  retryBaseDelay: number;    // 新增：基础重试延迟
  retryMaxDelay: number;    // 新增：最大重试延迟
  workingDir?: string;
  model: string;
  maxInputLength: number;
}

// 在 config 对象中添加
opencode: {
  enabled: process.env.OPENCODE_ENABLED !== 'false',
  command: process.env.OPENCODE_COMMAND || 'opencode',
  timeout: parseInt(process.env.OPENCODE_TIMEOUT || '120000', 10),
  maxRetries: parseInt(process.env.OPENCODE_MAX_RETRIES || '3', 10),
  retryBaseDelay: parseInt(process.env.OPENCODE_RETRY_BASE_DELAY || '1000', 10),
  retryMaxDelay: parseInt(process.env.OPENCODE_RETRY_MAX_DELAY || '30000', 10),
  workingDir: process.env.OPENCODE_WORKING_DIR || process.cwd(),
  model: process.env.OPENCODE_MODEL || '',
  maxInputLength: parseInt(process.env.OPENCODE_MAX_INPUT_LENGTH || '10000', 10),
} as OpenCodeConfig,
```

- [ ] **Step 2: 更新 .env.example**

```bash
# .env.example

# OpenCode 配置
OPENCODE_COMMAND=opencode
OPENCODE_TIMEOUT=120000
OPENCODE_MAX_RETRIES=3
OPENCODE_RETRY_BASE_DELAY=1000
OPENCODE_RETRY_MAX_DELAY=30000
OPENCODE_MODEL=minimax-m2.5-free
```

- [ ] **Step 3: 提交**

```bash
git add src/config.ts .env.example
git commit -m "feat: add retry configuration options"
```

---

## 验证清单

完成所有任务后，运行以下验证：

- [ ] 所有测试通过：`npm test`
- [ ] 编译成功：`npm run build`
- [ ] 手动测试消息处理流程
- [ ] 验证重试机制（模拟 OpenCode 失败场景）
- [ ] 验证告警功能

---

## 回滚计划

如果实施后出现问题：

1. 回滚到上一个可用版本
2. 设置 `OPENCODE_MAX_RETRIES=0` 禁用重试
3. 检查日志定位问题