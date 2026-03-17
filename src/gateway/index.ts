/**
 * Gateway 服务模块 - 基于 Stream 模式的消息处理
 * 所有消息通过 Stream 连接接收，无需 Webhook 回调
 */
import express, { Express, Request, Response, NextFunction } from 'express';
import { DingtalkService } from '../dingtalk/dingtalk';
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
import { MessageRetryQueue } from '../utils/messageRetryQueue';

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
  private openCodeExecutor: OpenCodeExecutor;
  private claudeCodeExecutor: ClaudeCodeExecutor;
  private sessionManager: SessionManager;
  private messageQueue: MessageQueue;
  private rateLimiter: RateLimiter;
  private concurrencyController: ConcurrencyController;
  private deduplicator: MessageDeduplicator;
  private messageRetryQueue: MessageRetryQueue;  // 消息重试队列
  private server: ReturnType<Express['listen']> | null = null;
  private consumerRunning: boolean = false; // 标记消费者是否运行
  private consumerTimer: NodeJS.Timeout | null = null; // 消费者定时器
  private retrySenderTimer: NodeJS.Timeout | null = null;  // 重试发送定时器

  constructor(
    dingtalkService: DingtalkService,
    deps: GatewayDeps
  ) {
    this.app = express();
    this.dingtalkService = dingtalkService;
    this.openCodeExecutor = deps.openCodeExecutor || new OpenCodeExecutor();
    this.claudeCodeExecutor = deps.claudeCodeExecutor || new ClaudeCodeExecutor();
    this.sessionManager = deps.sessionManager;
    this.messageQueue = deps.messageQueue;
    this.rateLimiter = deps.rateLimiter;
    this.concurrencyController = deps.concurrencyController;
    this.deduplicator = deps.deduplicator;
    this.messageRetryQueue = new MessageRetryQueue();

    const providerName = config.aiProvider === 'claude' ? 'Claude Code' : 'OpenCode';
    console.log(`✅ Gateway 已启用，所有消息将路由到 ${providerName}`);
    this.setupMiddleware();
    this.setupRoutes();

    // 启动消费者循环
    this.startConsumer();

    // 启动重试发送循环
    this.startRetrySender();
  }

  /**
   * 启动消息重试发送器
   */
  private startRetrySender(): void {
    const checkAndSend = async () => {
      const pending = this.messageRetryQueue.getPending();
      if (pending.length === 0) return;

      console.log(`[RetryQueue] 准备重试发送 ${pending.length} 条消息`);

      for (const msg of pending) {
        // 检查是否到达重试时间
        if (msg.lastAttemptAt) {
          const delay = this.calculateRetryDelay(msg.retryCount);
          if (Date.now() - msg.lastAttemptAt < delay) {
            continue;  // 还未到重试时间
          }
        }

        const started = this.messageRetryQueue.startSending(msg.id);
        if (!started) continue;

        try {
          const accessToken = await this.dingtalkService.getAccessToken();

          if (msg.type === 'markdown') {
            const replyTitle = msg.title || (config.aiProvider === 'claude' ? 'claude code 回复' : 'opencode 回复');
            await this.dingtalkService.sendMarkdownMessage(
              accessToken,
              replyTitle,
              msg.content
            );
          } else {
            await this.dingtalkService.sendTextMessage(
              accessToken,
              msg.content,
              msg.mentionList
            );
          }

          this.messageRetryQueue.markSent(msg.id);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.messageRetryQueue.markFailed(msg.id, errorMsg);
        }
      }
    };

    // 每 10 秒检查一次
    this.retrySenderTimer = setInterval(checkAndSend, 10 * 1000);
  }

  /**
   * 计算重试延迟
   */
  private calculateRetryDelay(retryCount: number): number {
    const baseDelay = 5000;  // 5 秒
    const delay = baseDelay * Math.pow(2, retryCount);
    return Math.min(delay, 5 * 60 * 1000);  // 最多 5 分钟
  }

  private setupMiddleware(): void {
    this.app.use(express.json());

    // 认证中间件 - 保护敏感接口
    this.app.use('/api/test', this.authMiddleware.bind(this));
    this.app.use('/api/sessions', this.authMiddleware.bind(this));
    this.app.use('/api/queue', this.authMiddleware.bind(this));
    this.app.use('/api/status', this.authMiddleware.bind(this));
    this.app.use('/api/doctor', this.authMiddleware.bind(this));

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
    // 如果没有配置 API 令牌，则跳过认证（开发环境）
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

    const token = authHeader.substring(7); // 移除 'Bearer ' 前缀
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
      const retryQueueStats = this.messageRetryQueue.getStats();
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
                  maxRetries: config.ai.maxRetries,          },
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
  }

  /**
   * 核心消息处理方法
   * 支持直接处理或队列处理模式
   */
  async processMessage(request: GatewayRequest, useQueue: boolean = false): Promise<GatewayResponse> {
    const { msg, userId = 'unknown', userName = '用户' } = request;

    if (useQueue) {
      console.log(`[Gateway] 接收到用户 ${userName}(${userId}) 的消息，加入队列：${msg.substring(0, 50)}...`);

      try {
        // 创建用户消息对象
        const userMessage: UserMessage = {
          id: generateMessageId(),
          type: 'user',
          conversationId: '', // 消费者处理时会获取或创建会话
          userId,
          username: userName,
          content: msg,
          metadata: {
            timestamp: Date.now(),
            source: 'dingtalk',
          },
        };

        // 将消息加入队列
        this.messageQueue.enqueue(userMessage, 'normal');
        
        // 立即返回成功响应
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
      // 直接处理模式（保持向后兼容）
      return this.processMessageInternal(request);
    }
  }

  /**
   * 构建传递给 OpenCode 的对话历史
   */
  private async buildHistoryForOpenCode(
    conversationId: string
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const messages = await this.sessionManager.getHistory(conversationId, 20);
    
    return messages
      .filter(msg => msg.type === 'user' || msg.type === 'ai')
      .map(msg => ({
        role: msg.type === 'user' ? 'user' as const : 'assistant' as const,
        content: msg.content,
      }));
  }

  /**
   * 处理来自 Stream 的消息并发送回复
   */
  async handleStreamMessage(
    msg: string,
    userId: string,
    userName: string
  ): Promise<void> {
    console.log(`[Gateway] 收到 Stream 消息：用户 ${userName}(${userId}) - ${msg}`);

    const maxRetries = 3;
    let lastError: Error | null = null;
    let conversationId = '';
    let replyContent = '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 处理消息
        const result = await this.processMessage({
          msg,
          userId,
          userName,
        });

        // 保存会话 ID 和回复内容
        if (result.data?.conversationId) {
          conversationId = result.data.conversationId;
        }

        // 发送回复
        const accessToken = await this.dingtalkService.getAccessToken();

        const replyTitle = config.aiProvider === 'claude' ? 'claude code 回复' : 'opencode 回复';
        if (result.success && result.data?.result) {
          const markdownText = renderMarkdown(result.data.result);
          replyContent = markdownText;

          try {
            await this.dingtalkService.sendMarkdownMessage(
              accessToken,
              replyTitle,
              markdownText
            );
            return; // 成功返回
          } catch (sendError) {
            // 发送失败，添加到重试队列
            console.error(`[Gateway] 发送回复失败，添加到重试队列`);
            const queueId = generateMessageId();
            this.messageRetryQueue.add(
              queueId,
              conversationId,
              'markdown',
              markdownText,
              { title: replyTitle }
            );
            // 通知用户消息会稍后送达
            await this.dingtalkService.sendTextMessage(
              accessToken,
              '📬 您的消息已收到，回复正在发送中，请稍候...'
            );
            return;
          }
        } else {
          // 处理失败，返回细化错误信息
          const errorMsg = this.formatErrorMessage(result.message, result.data?.messageId);
          replyContent = errorMsg;

          try {
            await this.dingtalkService.sendTextMessage(accessToken, errorMsg);
            return;
          } catch (sendError) {
            // 发送失败，添加到重试队列
            console.error(`[Gateway] 发送错误回复失败，添加到重试队列`);
            const queueId = generateMessageId();
            this.messageRetryQueue.add(
              queueId,
              conversationId,
              'text',
              errorMsg
            );
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

    // 所有重试都失败，添加到重试队列并通知用户
    console.error('[Gateway] 消息处理最终失败:', lastError);
    try {
      const accessToken = await this.dingtalkService.getAccessToken();
      const errorMessage = this.formatErrorMessage(
        lastError?.message || '未知错误',
        undefined,
        true
      );

      // 添加到重试队列
      if (conversationId) {
        const queueId = generateMessageId();
        this.messageRetryQueue.add(
          queueId,
          conversationId,
          'text',
          errorMessage
        );
      }

      // 通知用户会稍后重试
      await this.dingtalkService.sendTextMessage(
        accessToken,
        '⚠️ 消息处理遇到问题，系统将自动重试，请稍候查看回复。'
      );
    } catch (sendError) {
      console.error('[Gateway] 发送错误回复失败:', sendError);
    }
  }

  /**
   * 格式化错误信息，面向用户
   */
  private formatErrorMessage(
    error: string,
    messageId?: string,
    isSystemError = false
  ): string {
    const idPart = messageId ? `\n📋 追踪ID: ${messageId}` : '';

    // 细化错误类型
    if (error.includes('timeout') || error.includes('超时')) {
      return `⏱️ 处理超时\n\n我需要更多时间思考，请稍等片刻再试一次。${idPart}`;
    }
    if (error.includes('未安装') || error.includes('找不到命令') || error.includes('ENOENT')) {
      return `⚠️ OpenCode CLI 未正确安装\n\n请确保已安装 OpenCode:\n\`\`\`bash\nnpm install -g opencode\n\`\`\`${idPart}`;
    }
    if (error.includes('permission') || error.includes('Permission denied')) {
      return `🔒 权限不足\n\n无法执行操作，请检查权限设置。${idPart}`;
    }
    if (error.includes('network') || error.includes('Network') || error.includes('ECONNREFUSED')) {
      return `🌐 网络问题\n\n无法连接到服务，请检查网络后重试。${idPart}`;
    }
    if (error.includes('Rate limit') || error.includes('请求过于频繁')) {
      return `🚥 请求过于频繁\n\n请稍等片刻再发送消息。${idPart}`;
    }
    if (error.includes('系统繁忙') || error.includes('concurrent')) {
      return `🔥 系统繁忙\n\n当前用户并发请求过多，请稍后重试。${idPart}`;
    }
    if (error.includes('会话创建失败')) {
      return `🗣️ 会话创建失败\n\n请稍后重试，或重新发起对话。${idPart}`;
    }
    if (error.includes('消息已处理') || error.includes('重复')) {
      return `🔄 消息重复\n\n该消息已处理，请勿重复发送。${idPart}`;
    }

    // 默认错误信息
    if (isSystemError) {
      return `❌ 处理失败\n\n抱歉，我遇到了问题。请稍后重试。${idPart}`;
    }
    return `❌ ${error}${idPart}`;
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

      this.server!.on('error', (error) => {
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    // 停止消费者循环
    this.stopConsumer();
    
    if (this.server) {
      return new Promise((resolve) => {
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
    if (this.consumerRunning) {
      return;
    }
    
    this.consumerRunning = true;
    console.log('[Gateway] 消息消费者已启动');
    
    // 启动消费循环
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
    if (!this.consumerRunning) {
      return;
    }

    // 处理队列中的消息
    this.processQueuedMessages()
      .catch(error => {
        console.error('[Gateway] 处理队列消息时发生错误:', error);
      })
      .finally(() => {
        // 安排下次循环
        if (this.consumerRunning) {
          this.consumerTimer = setTimeout(() => {
            this.consumeLoop();
          }, 100); // 每100毫秒检查一次队列
        }
      });
  }

  /**
   * 处理队列中的消息
   */
  private async processQueuedMessages(): Promise<void> {
    try {
      // 批量获取消息（最多处理5条）
      const queuedMessages = this.messageQueue.batchDequeue(5);
      
      if (queuedMessages.length === 0) {
        return;
      }
      
      console.log(`[Gateway] 从队列中获取到 ${queuedMessages.length} 条消息`);
      
      // 并行处理消息
      const processPromises = queuedMessages.map(async (queuedMsg) => {
        const { message, retryCount } = queuedMsg;
        
        try {
          console.log(`[Gateway] 处理队列消息：${message.content.substring(0, 50)}...`);
          
          // 处理消息（注意：这里需要构造正确的request对象）
          const result = await this.processMessageInternal({
            msg: message.content,
            userId: message.userId,
            userName: message.username || '用户'
          });
          
          // 标记消息处理完成
          this.messageQueue.complete(message.id);
          
          console.log(`[Gateway] 队列消息处理完成: ${message.id}`);
        } catch (error) {
          console.error(`[Gateway] 处理队列消息失败: ${message.id}`, error);
          
          // 标记消息处理失败，重新入队
          this.messageQueue.fail(message.id);
          
          // 如果重试次数过多，记录错误日志
          if (retryCount >= 3) {
            console.error(`[Gateway] 消息重试次数过多，将丢弃: ${message.id}`);
          }
        }
      });
      
      // 等待所有消息处理完成
      await Promise.all(processPromises);
    } catch (error) {
      console.error('[Gateway] 处理队列消息时发生错误:', error);
    }
  }

  /**
   * 内部消息处理方法（从processMessage提取出的核心逻辑）
   */
  private async processMessageInternal(request: GatewayRequest): Promise<GatewayResponse> {
    const { msg, userId = 'unknown', userName = '用户' } = request;
    const startTime = Date.now();
    const messageId = generateMessageId();  // 追踪 ID

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
        message: `请求过于频繁，请稍后再试（剩余配额：${rateLimitResult.remaining}）`,
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
      // 设置30秒超时
      await this.concurrencyController.acquireSlot(userId, requestId, 30000);
      console.log(`[${messageId}] 步骤 5: 并发控制通过`);
    } catch (error) {
      console.error(`[${messageId}] 获取并发槽位失败:`, error);
      return {
        success: false,
        message: error instanceof Error && error.message.includes('超时')
          ? '系统繁忙，请稍后重试'
          : '系统资源不足，请稍后重试',
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

      // 8. 获取对话历史（传递给 OpenCode 作为上下文）
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

      console.log(`[${messageId}] ${providerName} 完成: success=${result.success}, time=${result.executionTime}ms`);

      // 11. 处理结果
      let responseContent: string;

      if (result.success && result.output) {
        responseContent = result.output;
      } else if (result.error) {
        // 如果是 CLI 未安装，给出友好提示
        if (result.error.includes('未安装') || result.error.includes('找不到命令')) {
          if (config.aiProvider === 'claude') {
            responseContent = `⚠️ Claude Code CLI 未安装\n\n` +
              `请先安装 Claude Code CLI:\n` +
              `\`\`\`bash\n` +
              `brew install anthropic/claude/claude\n\`\`\`\n\n` +
              `或配置环境变量 CLAUDE_COMMAND 指定 claude 命令路径。`;
          } else {
            responseContent = `⚠️ OpenCode CLI 未安装\n\n` +
              `请先安装 OpenCode CLI:\n` +
              `\`\`\`bash\n` +
              `npm install -g opencode\n` +
              `\`\`\`\n\n` +
              `或配置环境变量 OPENCODE_COMMAND 指定 opencode 命令路径。`;
          }
        } else {
          responseContent = `❌ 处理失败\n\n错误信息：${result.error}`;
        }
      } else {
        responseContent = '处理完成，但没有返回结果。';
      }

      // 12. 创建 AI 消息对象并保存到会话历史
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
          messageId,  // 追踪 ID
        },
      };
    } finally {
      // 14. 释放并发槽位
      this.concurrencyController.releaseSlot(userId, requestId);
    }
  }
}