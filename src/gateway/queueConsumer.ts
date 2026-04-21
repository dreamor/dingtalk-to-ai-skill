/**
 * 队列消费者
 * 负责从消息队列中消费消息并处理
 */

import { MessageQueue, QueuedMessage } from '../message-queue/messageQueue';
import { ConcurrencyController } from '../message-queue/concurrencyController';
import { RateLimiter } from '../message-queue/rateLimiter';
import { MessageDeduplicator } from '../utils/dedupCache';
import { SessionManager } from '../session-manager';
import { OpenCodeExecutor, MessageContext } from '../opencode';
import { ClaudeCodeExecutor } from '../claude';
import { UserMessage, AIMessage } from '../types/message';
import { generateMessageId } from '../utils/messageId';
import { config } from '../config';
import { formatError, getCLIInstallSuggestion } from './errorFormatter';

/**
 * 消息处理结果
 */
export interface ProcessResult {
  success: boolean;
  message: string;
  data?: {
    result?: string;
    conversationId?: string;
    executionTime?: number;
    messageId?: string;
  };
}

/**
 * 消息处理器类型
 */
export type MessageProcessor = (msg: string, userId: string, userName: string) => Promise<ProcessResult>;

/**
 * 队列消费者配置
 */
export interface QueueConsumerConfig {
  pollInterval: number;
  batchSize: number;
}

const DEFAULT_CONFIG: QueueConsumerConfig = {
  pollInterval: 100,  // 100ms
  batchSize: 5,
};

/**
 * 队列消费者类
 */
export class QueueConsumer {
  private queue: MessageQueue;
  private rateLimiter: RateLimiter;
  private concurrencyController: ConcurrencyController;
  private deduplicator: MessageDeduplicator;
  private sessionManager: SessionManager;
  private openCodeExecutor: OpenCodeExecutor;
  private claudeCodeExecutor: ClaudeCodeExecutor;
  private config: QueueConsumerConfig;
  private isRunning: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private messageHandler: MessageProcessor | null = null;

  constructor(
    queue: MessageQueue,
    rateLimiter: RateLimiter,
    concurrencyController: ConcurrencyController,
    deduplicator: MessageDeduplicator,
    sessionManager: SessionManager,
    openCodeExecutor: OpenCodeExecutor,
    claudeCodeExecutor: ClaudeCodeExecutor,
    config?: Partial<QueueConsumerConfig>
  ) {
    this.queue = queue;
    this.rateLimiter = rateLimiter;
    this.concurrencyController = concurrencyController;
    this.deduplicator = deduplicator;
    this.sessionManager = sessionManager;
    this.openCodeExecutor = openCodeExecutor;
    this.claudeCodeExecutor = claudeCodeExecutor;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 设置消息处理器（可选，用于替代默认处理逻辑）
   */
  setMessageHandler(handler: MessageProcessor): void {
    this.messageHandler = handler;
  }

  /**
   * 启动消费者
   */
  start(): void {
    if (this.isRunning) {
      console.log('[QueueConsumer] 已经在运行中');
      return;
    }

    this.isRunning = true;
    console.log('[QueueConsumer] 消息消费者已启动');
    console.log(`  - 轮询间隔: ${this.config.pollInterval}ms`);
    console.log(`  - 批处理大小: ${this.config.batchSize}`);

    this.consumeLoop();
  }

  /**
   * 停止消费者
   */
  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('[QueueConsumer] 消息消费者已停止');
  }

  /**
   * 消费循环
   */
  private consumeLoop(): void {
    if (!this.isRunning) return;

    this.processBatch()
      .catch(error => {
        console.error('[QueueConsumer] 处理消息时发生错误:', error);
      })
      .finally(() => {
        if (this.isRunning) {
          this.timer = setTimeout(() => this.consumeLoop(), this.config.pollInterval);
        }
      });
  }

  /**
   * 批量处理消息
   */
  private async processBatch(): Promise<void> {
    const messages = this.queue.batchDequeue(this.config.batchSize);
    if (messages.length === 0) return;

    console.log(`[QueueConsumer] 从队列获取 ${messages.length} 条消息`);

    const processPromises = messages.map(msg => this.processQueuedMessage(msg));
    await Promise.all(processPromises);
  }

  /**
   * 处理单条队列消息
   */
  private async processQueuedMessage(queuedMsg: QueuedMessage): Promise<void> {
    const { message, retryCount } = queuedMsg;
    
    try {
      console.log(`[QueueConsumer] 处理消息：${message.content.substring(0, 50)}...`);
      
      if (this.messageHandler) {
        await this.messageHandler(message.content, message.userId, message.username || '用户');
      } else {
        await this.processMessageInternal(message);
      }
      
      this.queue.complete(message.id);
      console.log(`[QueueConsumer] 消息处理完成: ${message.id}`);
    } catch (error) {
      console.error(`[QueueConsumer] 消息处理失败: ${message.id}`, error);
      this.queue.fail(message.id);
      
      if (retryCount >= 3) {
        console.error(`[QueueConsumer] 消息重试次数过多，将丢弃: ${message.id}`);
      }
    }
  }

  /**
   * 内部消息处理逻辑
   */
  private async processMessageInternal(message: UserMessage): Promise<ProcessResult> {
    const startTime = Date.now();
    const messageId = generateMessageId();

    // 1. 消息去重检查
    if (this.deduplicator.isDuplicate(message.content, message.userId)) {
      console.log(`[QueueConsumer] 检测到重复消息: ${message.id}`);
      return {
        success: false,
        message: '消息已处理，请勿重复发送',
      };
    }
    this.deduplicator.record(message.content, message.userId);

    // 2. 流量控制检查
    const rateLimitResult = this.rateLimiter.checkRateLimit(message.userId);
    if (!rateLimitResult.allowed) {
      console.log(`[QueueConsumer] 流量限制: ${message.userId}`);
      return {
        success: false,
        message: `请求过于频繁，请稍后再试（剩余配额：${rateLimitResult.remaining}）`,
      };
    }
    this.rateLimiter.consumeToken(message.userId);

    // 3. 获取或创建会话
    let session;
    try {
      session = await this.sessionManager.getOrCreateSession(message.userId);
    } catch (error) {
      console.error(`[QueueConsumer] 创建会话失败:`, error);
      return {
        success: false,
        message: '会话创建失败，请稍后重试',
      };
    }

    // 4. 并发控制
    const requestId = generateMessageId();
    try {
      await this.concurrencyController.acquireSlot(message.userId, requestId, 30000);
    } catch (error) {
      console.error(`[QueueConsumer] 获取并发槽位失败:`, error);
      return {
        success: false,
        message: error instanceof Error && error.message.includes('超时')
          ? '系统繁忙，请稍后重试'
          : '系统资源不足，请稍后重试',
      };
    }

    try {
      // 5. 添加消息到会话历史
      await this.sessionManager.addMessage(session.conversationId, message);

      // 6. 获取对话历史
      const history = await this.buildHistory(session.conversationId);

      // 7. 构建 AI 上下文
      const context: MessageContext = {
        userId: message.userId,
        userName: message.username,
        conversationId: session.conversationId,
        history,
      };

      // 8. 根据配置的 AI Provider 调用相应的 CLI
      const providerName = config.aiProvider === 'claude' ? 'Claude Code' : 'OpenCode';
      let result;
      
      if (config.aiProvider === 'claude') {
        result = await this.claudeCodeExecutor.execute(message.content, context);
      } else {
        result = await this.openCodeExecutor.execute(message.content, context);
      }

      // 9. 生成用户消息
      let responseContent: string;
      
      if (result.success && result.output) {
        responseContent = result.output;
      } else if (result.error) {
        if (result.error.includes('未安装') || result.error.includes('找不到命令') || result.error.includes('ENOENT')) {
          responseContent = getCLIInstallSuggestion(config.aiProvider);
        } else {
          responseContent = formatError(result.error, messageId);
        }
      } else {
        responseContent = '处理完成，但没有返回结果。';
      }

      // 10. 创建 AI 消息并保存
      const aiMessage: AIMessage = {
        id: generateMessageId(),
        type: 'ai',
        conversationId: session.conversationId,
        userId: message.userId,
        content: responseContent,
        metadata: {
          timestamp: Date.now(),
          source: 'ai',
        },
      };

      await this.sessionManager.addMessage(session.conversationId, aiMessage);

      const totalTime = Date.now() - startTime;
      console.log(`[QueueConsumer] 消息处理完成，耗时：${totalTime}ms`);

      return {
        success: result.success,
        message: result.success ? '处理成功' : '处理失败',
        data: {
          result: responseContent,
          conversationId: session.conversationId,
          executionTime: totalTime,
          messageId,
        },
      };
    } finally {
      this.concurrencyController.releaseSlot(message.userId, requestId);
    }
  }

  /**
   * 构建对话历史
   */
  private async buildHistory(conversationId: string): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const messages = await this.sessionManager.getHistory(conversationId, 20);
    
    return messages
      .filter(msg => msg.type === 'user' || msg.type === 'ai')
      .map(msg => ({
        role: msg.type === 'user' ? 'user' as const : 'assistant' as const,
        content: msg.content,
      }));
  }

  /**
   * 获取消费者状态
   */
  getStatus(): { isRunning: boolean; pollInterval: number; batchSize: number } {
    return {
      isRunning: this.isRunning,
      pollInterval: this.config.pollInterval,
      batchSize: this.config.batchSize,
    };
  }
}

/**
 * 创建队列消费者实例
 */
export function createQueueConsumer(
  queue: MessageQueue,
  rateLimiter: RateLimiter,
  concurrencyController: ConcurrencyController,
  deduplicator: MessageDeduplicator,
  sessionManager: SessionManager,
  openCodeExecutor: OpenCodeExecutor,
  claudeCodeExecutor: ClaudeCodeExecutor,
  config?: Partial<QueueConsumerConfig>
): QueueConsumer {
  return new QueueConsumer(
    queue,
    rateLimiter,
    concurrencyController,
    deduplicator,
    sessionManager,
    openCodeExecutor,
    claudeCodeExecutor,
    config
  );
}
