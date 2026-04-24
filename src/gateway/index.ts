/**
 * Gateway 服务模块 - 基于 Stream 模式的消息处理
 * 所有消息通过 Stream 连接接收，无需 Webhook 回调
 *
 * 重构说明：
 * - 错误格式化逻辑移至 errorFormatter.ts
 * - 消息重试逻辑移至 retrySender.ts
 * - 队列消费逻辑移至 queueConsumer.ts
 */
import express, { Express, Request, Response, NextFunction } from 'express';
import { DingtalkService } from '../dingtalk/dingtalk';
import { DingtalkStreamService } from '../dingtalk/stream';
import { SessionManager } from '../session-manager';
import { MessageQueue } from '../message-queue/messageQueue';
import { RateLimiter } from '../message-queue/rateLimiter';
import { ConcurrencyController } from '../message-queue/concurrencyController';
import { MessageDeduplicator } from '../utils/dedupCache';
import { OpenCodeExecutor, type MessageContext } from '../opencode';
import { ClaudeCodeExecutor } from '../claude';
import { config } from '../config';
import { UserMessage, AIMessage } from '../types/message';
import { generateMessageId } from '../utils/messageId';
import { renderMarkdown } from '../utils/markdown';
import { buildHistory } from '../utils/historyBuilder';
import {
  formatError,
  getCLIInstallSuggestion,
  formatRateLimitMessage,
  formatBusyMessage,
} from './errorFormatter';
import { RetrySender, type MessageSender } from './retrySender';
import { Scheduler } from '../scheduler';

// Gateway 依赖接口
export interface GatewayDeps {
  sessionManager: SessionManager;
  messageQueue: MessageQueue;
  rateLimiter: RateLimiter;
  concurrencyController: ConcurrencyController;
  deduplicator: MessageDeduplicator;
  openCodeExecutor?: OpenCodeExecutor;
  claudeCodeExecutor?: ClaudeCodeExecutor;
}

interface GatewayRequest {
  msg: string;
  userId?: string;
  userName?: string;
  conversationId?: string;
}

interface GatewayResponse {
  success: boolean;
  message: string;
  data?: {
    result?: string;
    conversationId?: string;
    executionTime?: number;
    messageId?: string;
  };
}

export class GatewayServer {
  private app: Express;
  private dingtalkService: DingtalkService;
  private streamService: DingtalkStreamService | null = null;
  private openCodeExecutor: OpenCodeExecutor;
  private claudeCodeExecutor: ClaudeCodeExecutor;
  private sessionManager: SessionManager;
  private messageQueue: MessageQueue;
  private rateLimiter: RateLimiter;
  private concurrencyController: ConcurrencyController;
  private deduplicator: MessageDeduplicator;
  private retrySender: RetrySender;
  private scheduler: Scheduler | null = null;
  private server: ReturnType<Express['listen']> | null = null;
  private consumerRunning: boolean = false;
  private consumerTimer: NodeJS.Timeout | null = null;

  constructor(dingtalkService: DingtalkService, deps: GatewayDeps) {
    this.app = express();
    this.dingtalkService = dingtalkService;
    this.openCodeExecutor = deps.openCodeExecutor || new OpenCodeExecutor();
    this.claudeCodeExecutor = deps.claudeCodeExecutor || new ClaudeCodeExecutor();
    this.sessionManager = deps.sessionManager;
    this.messageQueue = deps.messageQueue;
    this.rateLimiter = deps.rateLimiter;
    this.concurrencyController = deps.concurrencyController;
    this.deduplicator = deps.deduplicator;
    this.retrySender = new RetrySender({
      maxRetries: 5,
      baseDelay: 5000,
      maxDelay: 300000,
      checkInterval: 10000,
    });

    const providerName = config.aiProvider === 'claude' ? 'Claude Code' : 'OpenCode';
    console.log(`✅ Gateway 已启用，所有消息将路由到 ${providerName}`);

    this.setupMiddleware();
    this.setupRoutes();
    this.startConsumer();
    this.setupRetrySender();
  }

  /**
   * 设置重试发送器
   */
  private setupRetrySender(): void {
    const sender: MessageSender = async (conversationId, content, title, mentionList) => {
      try {
        const accessToken = await this.dingtalkService.getAccessToken();

        if (title) {
          await this.dingtalkService.sendMarkdownMessage(accessToken, title, content);
        } else {
          await this.dingtalkService.sendTextMessage(accessToken, content, mentionList);
        }
        return true;
      } catch (error) {
        console.error('[Gateway] 发送消息失败:', error);
        return false;
      }
    };

    this.retrySender.setSender(sender);
    this.retrySender.start();
  }

  /**
   * 设置 Stream 服务（由 index.ts 调用）
   */
  setStreamService(service: DingtalkStreamService): void {
    this.streamService = service;
  }

  setScheduler(scheduler: Scheduler): void {
    this.scheduler = scheduler;
  }

  private setupMiddleware(): void {
    this.app.use(express.json());

    // 认证中间件 - 保护敏感接口
    this.app.use('/api/test', this.authMiddleware.bind(this));
    this.app.use('/api/sessions', this.authMiddleware.bind(this));
    this.app.use('/api/queue', this.authMiddleware.bind(this));
    this.app.use('/api/status', this.authMiddleware.bind(this));
    this.app.use('/api/doctor', this.authMiddleware.bind(this));
    this.app.use('/api/scheduler', this.authMiddleware.bind(this));

    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
      next();
    });

    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error('请求处理错误:', err);
      res.status(500).json({
        success: false,
        message: '内部服务器错误',
      });
    });
  }

  /**
   * API 认证中间件
   */
  private authMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!config.gateway.apiToken) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        message: '缺少认证信息',
      });
      return;
    }

    const token = authHeader.substring(7);
    if (token !== config.gateway.apiToken) {
      res.status(401).json({
        success: false,
        message: '认证失败',
      });
      return;
    }

    next();
  }

  private setupRoutes(): void {
    // 健康检查
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        mode: 'stream',
      });
    });

    // 测试接口
    this.app.post('/api/test', async (req: Request, res: Response) => {
      try {
        const result = await this.processMessage({
          msg: req.body.msg || '',
          userId: 'test-user',
          userName: '测试用户',
        });
        res.json(result);
      } catch (error) {
        res.status(500).json({
          success: false,
          message: error instanceof Error ? error.message : '未知错误',
        });
      }
    });

    // 获取会话状态
    this.app.get('/api/sessions', async (_req: Request, res: Response) => {
      const stats = await this.sessionManager.getStats();
      res.json({
        success: true,
        data: stats,
      });
    });

    // 获取队列状态
    this.app.get('/api/queue', (_req: Request, res: Response) => {
      res.json({
        success: true,
        data: this.messageQueue.getStatus(),
      });
    });

    // 检查 AI Provider 状态
    this.app.get('/api/status', async (_req: Request, res: Response) => {
      const [opencodeAvailable, claudeAvailable] = await Promise.all([
        this.openCodeExecutor.isAvailable(),
        this.claudeCodeExecutor.isAvailable(),
      ]);
      const queueStatus = this.messageQueue.getStatus();
      const retryQueueStats = this.retrySender.getStats();
      const rateLimitStatus = {
        maxTokensPerUser: this.rateLimiter.getMaxTokens(),
        currentUsers: this.rateLimiter.getUserCount(),
      };
      const concurrencyStatus = {
        maxPerUser: this.concurrencyController.getMaxSlotsPerUser(),
        maxGlobal: this.concurrencyController.getMaxGlobalSlots(),
        availablePerUser: this.concurrencyController.getAvailableSlots('testUser'),
        availableGlobal: this.concurrencyController.getAvailableGlobalSlots(),
      };

      res.json({
        success: true,
        data: {
          aiProvider: config.aiProvider,
          opencode: {
            available: opencodeAvailable,
            command: config.ai.command,
            timeout: config.ai.timeout,
            maxRetries: config.ai.maxRetries,
          },
          claude: {
            available: claudeAvailable,
            command: config.claude.command,
            timeout: config.claude.timeout,
            maxRetries: config.claude.maxRetries,
          },
          messageQueue: {
            pending: queueStatus.queued,
            processing: queueStatus.processing,
            byPriority: queueStatus.byPriority,
          },
          retryQueue: retryQueueStats,
          rateLimit: rateLimitStatus,
          concurrency: concurrencyStatus,
        },
      });
    });

    // 系统诊断
    this.app.get('/api/doctor', async (_req: Request, res: Response) => {
      const { runDoctor } = await import('../utils/doctor');
      const results = await runDoctor();

      const passCount = results.filter(r => r.status === 'pass').length;
      const warnCount = results.filter(r => r.status === 'warn').length;
      const failCount = results.filter(r => r.status === 'fail').length;

      res.json({
        success: failCount === 0,
         data: {
          results,
          summary: { pass: passCount, warn: warnCount, fail: failCount },
        },
      });
    });

    // 定时任务管理
    this.app.get('/api/scheduler', (_req: Request, res: Response) => {
      const scheduler = this.scheduler;
      if (!scheduler) {
        res.json({ success: false, message: '调度器未启用' });
        return;
      }
      res.json({ success: true, data: scheduler.getStatus() });
    });

    this.app.post('/api/scheduler', (req: Request, res: Response) => {
      const scheduler = this.scheduler;
      if (!scheduler) {
        res.json({ success: false, message: '调度器未启用' });
        return;
      }
      const { name, cron, prompt, conversationId, enabled } = req.body;
      if (!name || !cron || !prompt || !conversationId) {
        res.json({ success: false, message: '缺少必填字段: name, cron, prompt, conversationId' });
        return;
      }
      const task = scheduler.addTask({ name, cron, prompt, conversationId, enabled });
      res.json({ success: true,  task });
    });

    this.app.delete('/api/scheduler/:id', (req: Request, res: Response) => {
      const scheduler = this.scheduler;
      if (!scheduler) {
        res.json({ success: false, message: '调度器未启用' });
        return;
      }
      const removed = scheduler.removeTask(req.params.id);
      res.json({ success: removed, message: removed ? '任务已删除' : '任务不存在' });
    });

    this.app.patch('/api/scheduler/:id/toggle', (req: Request, res: Response) => {
      const scheduler = this.scheduler;
      if (!scheduler) {
        res.json({ success: false, message: '调度器未启用' });
        return;
      }
      const task = scheduler.toggleTask(req.params.id);
      res.json({ success: !!task,  task: task, message: task ? `任务已${task.enabled ? '启用' : '停用'}` : '任务不存在' });
    });
  }

  /**
   * 核心消息处理方法
   */
  async processMessage(
    request: GatewayRequest,
    useQueue: boolean = false
  ): Promise<GatewayResponse> {
    const { msg, userId = 'unknown', userName = '用户' } = request;

    if (useQueue) {
      console.log(
        `[Gateway] 接收到用户 ${userName}(${userId}) 的消息，加入队列：${msg.substring(0, 50)}...`
      );

      try {
        const userMessage: UserMessage = {
          id: generateMessageId(),
          type: 'user',
          conversationId: '',
          userId,
          username: userName,
          content: msg,
          metadata: {
            timestamp: Date.now(),
            source: 'dingtalk',
          },
        };

        this.messageQueue.enqueue(userMessage, 'normal');

        return {
          success: true,
          message: '消息已接收，正在处理中',
          data: {
            messageId: userMessage.id,
          },
        };
      } catch (error) {
        console.error('[Gateway] 入队消息失败:', error);
        return {
          success: false,
          message: '消息接收失败',
        };
      }
    } else {
      return this.processMessageInternal(request);
    }
  }

  /**
   * 处理来自 Stream 的消息并发送回复
   */
  async handleStreamMessage(msg: string, userId: string, userName: string): Promise<void> {
    console.log(`[Gateway] 收到 Stream 消息：用户 ${userName}(${userId}) - ${msg}`);

    const maxRetries = 3;
    let lastError: Error | null = null;
    let conversationId = '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.processMessage({
          msg,
          userId,
          userName,
        });

        if (result.data?.conversationId) {
          conversationId = result.data.conversationId;
        }

        const accessToken = await this.dingtalkService.getAccessToken();
        const replyTitle = config.aiProvider === 'claude' ? 'Claude Code 回复' : 'AI 回复';

        if (result.success && result.data?.result) {
          const markdownText = renderMarkdown(result.data.result);

          try {
            await this.dingtalkService.sendMarkdownMessage(accessToken, replyTitle, markdownText);
            return;
          } catch (_sendError) {
            console.error(`[Gateway] 发送回复失败，添加到重试队列`);
            const queueId = generateMessageId();
            this.retrySender.add(queueId, conversationId, 'markdown', markdownText, {
              title: replyTitle,
            });
            await this.dingtalkService.sendTextMessage(
              accessToken,
              '📬 您的消息已收到，回复正在发送中，请稍候...'
            );
            return;
          }
        } else {
          const errorMsg = formatError(result.message, result.data?.messageId);

          try {
            await this.dingtalkService.sendTextMessage(accessToken, errorMsg);
            return;
          } catch (_sendError) {
            console.error(`[Gateway] 发送错误回复失败，添加到重试队列`);
            const queueId = generateMessageId();
            this.retrySender.add(queueId, conversationId, 'text', errorMsg);
            return;
          }
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`[Gateway] 第 ${attempt} 次处理失败:`, lastError.message);

        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          console.log(`[Gateway] ${delay}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    console.error('[Gateway] 消息处理最终失败:', lastError);
    try {
      const accessToken = await this.dingtalkService.getAccessToken();
      const errorMessage = formatError(lastError?.message || '未知错误', undefined, true);

      if (conversationId) {
        const queueId = generateMessageId();
        this.retrySender.add(queueId, conversationId, 'text', errorMessage);
      }

      await this.dingtalkService.sendTextMessage(
        accessToken,
        '⚠️ 消息处理遇到问题，系统将自动重试，请稍候查看回复。'
      );
    } catch (_sendError) {
      console.error('[Gateway] 发送错误回复失败:', _sendError);
    }
  }

  async start(port: number, host: string = '0.0.0.0'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, host, () => {
        console.log(`🚀 Gateway 服务器已启动`);
        console.log(`   - 地址：http://${host}:${port}`);
        console.log(`   - 健康检查：http://${host}:${port}/health`);
        console.log(`   - 测试接口：http://${host}:${port}/api/test`);
        console.log(`   - 状态检查：http://${host}:${port}/api/status`);
        resolve();
      });

      this.server!.on('error', error => {
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopConsumer();
    this.retrySender.stop();

    if (this.server) {
      return new Promise(resolve => {
        this.server!.close(() => {
          console.log('🛑 Gateway 服务器已停止');
          resolve();
        });
      });
    }
  }

  /**
   * 启动消费者循环
   */
  private startConsumer(): void {
    if (this.consumerRunning) return;

    this.consumerRunning = true;
    console.log('[Gateway] 消息消费者已启动');
    this.consumeLoop();
  }

  /**
   * 停止消费者循环
   */
  private stopConsumer(): void {
    this.consumerRunning = false;
    if (this.consumerTimer) {
      clearTimeout(this.consumerTimer);
      this.consumerTimer = null;
    }
    console.log('[Gateway] 消息消费者已停止');
  }

  /**
   * 消费循环
   */
  private consumeLoop(): void {
    if (!this.consumerRunning) return;

    this.processQueuedMessages()
      .catch(error => {
        console.error('[Gateway] 处理队列消息时发生错误:', error);
      })
      .finally(() => {
        if (this.consumerRunning) {
          this.consumerTimer = setTimeout(
            () => this.consumeLoop(),
            config.messageQueue.pollInterval
          );
        }
      });
  }

  /**
   * 处理队列中的消息
   */
  private async processQueuedMessages(): Promise<void> {
    const queuedMessages = this.messageQueue.batchDequeue(5);
    if (queuedMessages.length === 0) return;

    console.log(`[Gateway] 从队列中获取到 ${queuedMessages.length} 条消息`);

    const processPromises = queuedMessages.map(async queuedMsg => {
      const { message, retryCount } = queuedMsg;

      try {
        console.log(`[Gateway] 处理队列消息：${message.content.substring(0, 50)}...`);
        await this.processMessageInternal({
          msg: message.content,
          userId: message.userId,
          userName: message.username || '用户',
        });
        this.messageQueue.complete(message.id);
        console.log(`[Gateway] 队列消息处理完成: ${message.id}`);
      } catch (error) {
        console.error(`[Gateway] 处理队列消息失败: ${message.id}`, error);
        this.messageQueue.fail(message.id);

        if (retryCount >= 3) {
          console.error(`[Gateway] 消息重试次数过多，将丢弃: ${message.id}`);
        }
      }
    });

    await Promise.all(processPromises);
  }

  /**
   * 内部消息处理方法
   */
  private async processMessageInternal(request: GatewayRequest): Promise<GatewayResponse> {
    const { msg, userId = 'unknown', userName = '用户' } = request;
    const startTime = Date.now();
    const messageId = generateMessageId();

    console.log(`[${messageId}] 处理消息：${userName}(${userId}): ${msg.substring(0, 50)}...`);

    // 1. 基础验证
    if (!msg || msg.trim() === '') {
      return {
        success: false,
        message: '消息内容为空',
      };
    }

    // 2. 消息去重检查
    if (this.deduplicator.isDuplicate(msg, userId)) {
      console.log(`[Gateway] 检测到重复消息，已忽略：${msg.substring(0, 50)}`);
      return {
        success: false,
        message: '消息已处理，请勿重复发送',
      };
    }
    this.deduplicator.record(msg, userId);

    // 3. 流量控制检查
    const rateLimitResult = this.rateLimiter.checkRateLimit(userId);
    if (!rateLimitResult.allowed) {
      console.log(`[${messageId}] 流量控制：剩余配额 ${rateLimitResult.remaining}`);
      return {
        success: false,
        message: formatRateLimitMessage(rateLimitResult.remaining),
      };
    }
    this.rateLimiter.consumeToken(userId);

    // 4. 获取或创建会话
    let session;
    try {
      session = await this.sessionManager.getOrCreateSession(userId);
      console.log(`[${messageId}] 步骤 3-4: 验证通过，会话已获取 ${session.conversationId}`);
    } catch (error) {
      console.error(`[${messageId}] 创建会话失败:`, error);
      return {
        success: false,
        message: '会话创建失败，请稍后重试',
      };
    }

    // 5. 并发控制
    const requestId = generateMessageId();
    try {
      await this.concurrencyController.acquireSlot(userId, requestId, 30000);
      console.log(`[${messageId}] 步骤 5: 并发控制通过`);
    } catch (error) {
      console.error(`[${messageId}] 获取并发槽位失败:`, error);
      return {
        success: false,
        message: formatBusyMessage(),
      };
    }

    try {
      // 6. 创建用户消息对象
      const userMessage: UserMessage = {
        id: generateMessageId(),
        type: 'user',
        conversationId: session.conversationId,
        userId,
        username: userName,
        content: msg,
        metadata: {
          timestamp: Date.now(),
          source: 'dingtalk',
        },
      };

      // 7. 添加消息到会话历史
      await this.sessionManager.addMessage(session.conversationId, userMessage);

      // 8. 获取对话历史
      const history = await this.buildHistoryForOpenCode(session.conversationId);

      // 9. 构建 OpenCode 上下文
      const opencodeContext: MessageContext = {
        userId,
        userName,
        conversationId: session.conversationId,
        history,
      };

      // 10. 根据配置的 AI Provider 调用相应的 CLI
      const providerName = config.aiProvider === 'claude' ? 'Claude Code' : 'OpenCode';
      console.log(`[${messageId}] 步骤 6-9: 消息创建、历史构建完成，准备调用 ${providerName}`);

      let result;
      if (config.aiProvider === 'claude') {
        result = await this.claudeCodeExecutor.execute(msg, opencodeContext);
      } else {
        result = await this.openCodeExecutor.execute(msg, opencodeContext);
      }

      console.log(
        `[${messageId}] ${providerName} 完成: success=${result.success}, time=${result.executionTime}ms`
      );

      // 11. 处理结果
      let responseContent: string;

      if (result.success && result.output) {
        responseContent = result.output;
      } else if (result.error) {
        if (
          result.error.includes('未安装') ||
          result.error.includes('找不到命令') ||
          result.error.includes('ENOENT')
        ) {
          responseContent = getCLIInstallSuggestion(config.aiProvider);
        } else {
          responseContent = formatError(result.error, messageId);
        }
      } else {
        responseContent = '处理完成，但没有返回结果。';
      }

      // 12. 创建 AI 消息对象并保存
      const aiMessage: AIMessage = {
        id: generateMessageId(),
        type: 'ai',
        conversationId: session.conversationId,
        userId,
        content: responseContent,
        metadata: {
          timestamp: Date.now(),
          source: 'ai',
        },
      };

      await this.sessionManager.addMessage(session.conversationId, aiMessage);

      // 13. 返回结果
      const totalTime = Date.now() - startTime;
      console.log(`[${messageId}] 消息处理完成，总耗时：${totalTime}ms`);

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
      // 14. 释放并发槽位
      this.concurrencyController.releaseSlot(userId, requestId);
    }
  }

  /**
   * 构建传递给 OpenCode 的对话历史
   */
  private async buildHistoryForOpenCode(
    conversationId: string
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    return buildHistory(this.sessionManager, conversationId, 20);
  }
}
