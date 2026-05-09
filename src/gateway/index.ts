/**
 * Gateway 服务模块 - 基于 Stream 模式的消息处理
 * 所有消息通过 Stream 连接接收，无需 Webhook 回调
 *
 * 重构说明：
 * - 错误格式化逻辑移至 errorFormatter.ts
 * - 消息重试逻辑移至 retrySender.ts
 * - 队列消费逻辑移至 queueConsumer.ts
 * - 路由逻辑移至 routes/ 目录
 */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import express, { Express, Request, Response, NextFunction } from 'express';
import axios from 'axios';
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
import { renderMarkdown, preprocessDingTalkMarkdown } from '../utils/markdown';
import { createAdminRouter } from '../web';
import { StreamingCardManager } from '../dingtalk/streamingCard';
import { hookRunner } from '../hooks';
import type { HookEvent } from '../hooks';
import { buildHistory } from '../utils/historyBuilder';
import {
  formatError,
  getCLIInstallSuggestion,
  formatRateLimitMessage,
  formatBusyMessage,
} from './errorFormatter';
import { RetrySender, type MessageSender } from './retrySender';
import { CardBuilder, CardSender } from '../dingtalk/cards';
import { Scheduler } from '../scheduler';
import { parseCommand } from '../commands/commandParser';
import { CommandHandler } from '../commands/commandHandler';
import { ProviderRegistry, MessageRouter } from '../router';
import { MemoryManager } from '../memory';
import { DisplayFilter } from '../display';
import {
  createStatusRoutes,
  createSchedulerRouter,
  createRouterRoutes,
  createMemoryRoutes,
} from './routes';

// Gateway 依赖接口
export interface GatewayDeps {
  sessionManager: SessionManager;
  messageQueue: MessageQueue;
  rateLimiter: RateLimiter;
  concurrencyController: ConcurrencyController;
  deduplicator: MessageDeduplicator;
  openCodeExecutor?: OpenCodeExecutor;
  claudeCodeExecutor?: ClaudeCodeExecutor;
  memoryManager?: MemoryManager;
}

interface GatewayRequest {
  msg: string;
  userId?: string;
  userName?: string;
  conversationId?: string;
  sessionWebhook?: string;
  conversationType?: 'group' | 'user';
}

interface GatewayResponse {
  success: boolean;
  message: string;
  data?: {
    result?: string;
    conversationId?: string;
    executionTime?: number;
    messageId?: string;
    streamingSent?: boolean;
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
  private cardSender: CardSender | null = null;
  private scheduler: Scheduler | null = null;
  private commandHandler: CommandHandler;
  private router: MessageRouter | null = null;
  private providerRegistry: ProviderRegistry | null = null;
  private memoryManager: MemoryManager | null;
  private server: ReturnType<Express['listen']> | null = null;
  private streamingCardManager: StreamingCardManager | null = null;
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

    // 初始化命令处理器
    this.memoryManager = deps.memoryManager ?? null;

    // 初始化命令处理器
    this.commandHandler = new CommandHandler({
      sessionManager: deps.sessionManager,
      messageQueue: deps.messageQueue,
      stopSession: async (conversationId: string) => {
        try {
          await this.claudeCodeExecutor.closeSessionPoolSession(conversationId);
          return true;
        } catch {
          return false;
        }
      },
    });

    const providerName = config.aiProvider === 'claude' ? 'Claude Code' : 'OpenCode';
    console.log(`✅ Gateway 已启用，所有消息将路由到 ${providerName}`);

    this.setupMiddleware();
    this.setupRoutes();
    this.app.use(createAdminRouter());
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
      } catch (error: unknown) {
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
    // 将命令处理器注入到 Stream 服务
    service.setCommandHandler(this.commandHandler);
  }

  setScheduler(scheduler: Scheduler): void {
    this.scheduler = scheduler;
  }

  setStreamingCardManager(manager: StreamingCardManager): void {
    this.streamingCardManager = manager;
    console.log('[Gateway] StreamingCardManager 已设置');
  }

  setRouter(router: MessageRouter, registry: ProviderRegistry): void {
    this.router = router;
    this.providerRegistry = registry;
    console.log('[Gateway] Router 已设置');
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
    this.app.use('/api/router', this.authMiddleware.bind(this));
    this.app.use('/api/memory', this.authMiddleware.bind(this));

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
    // 状态与诊断路由
    const statusRoutes = createStatusRoutes({
      getSessionManager: () => this.sessionManager,
      getMessageQueue: () => this.messageQueue,
      getRateLimiter: () => this.rateLimiter,
      getConcurrencyController: () => this.concurrencyController,
      getRetrySender: () => this.retrySender,
      getOpenCodeExecutor: () => this.openCodeExecutor,
      getClaudeCodeExecutor: () => this.claudeCodeExecutor,
    });
    this.app.use(statusRoutes);

    // 测试接口（需要注入 processMessage，在此单独注册）
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.app.post('/api/test', async (req: Request, res: Response) => {
      try {
        const result = await this.processMessage({
          msg: req.body.msg || '',
          userId: 'test-user',
          userName: '测试用户',
        });
        res.json(result);
      } catch (error: unknown) {
        res.status(500).json({
          success: false,
          message: error instanceof Error ? error.message : '未知错误',
        });
      }
    });

    // 互动卡片 API
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.app.post('/api/card/send', async (req: Request, res: Response) => {
      try {
        const { conversationId, title, content, buttons, imageUrl } = req.body;

        if (!conversationId || !title || !content) {
          res.status(400).json({
            success: false,
            message: '缺少必要参数：conversationId, title, content',
          });
          return;
        }

        if (!this.streamService) {
          res.status(503).json({
            success: false,
            message: 'Stream 服务未连接',
          });
          return;
        }

        const cardData = CardBuilder.createMarkdownCard({
          title,
          content,
          buttons,
          imageUrl,
        });

        const sent = await this.streamService.sendCardMessage(conversationId, cardData);

        res.json({
          success: sent,
          message: sent ? '卡片发送成功' : '卡片发送失败',
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('[Gateway] 发送卡片失败:', msg);
        res.status(500).json({
          success: false,
          message: `发送卡片失败: ${msg}`,
        });
      }
    });

    // 定时任务路由
    this.app.use(createSchedulerRouter(() => this.scheduler));

    // 多 Agent 路由管理
    this.app.use(
      createRouterRoutes(
        () => this.providerRegistry,
        () => this.router
      )
    );

    // 项目记忆路由
    this.app.use(createMemoryRoutes(() => this.memoryManager));
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
      } catch (error: unknown) {
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

    // 触发消息接收钩子
    hookRunner
      .trigger('message_received' as HookEvent, {
        userId,
        userName,
        conversationId: '',
        content: msg.substring(0, 200),
      })
      .catch(() => {});

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

        // 流式模式下，卡片已经在 processMessage 中发送，不需要再发送 markdown
        const useStreaming = config.streaming.enabled && this.streamingCardManager;
        if (useStreaming) {
          console.log(`[Gateway] 流式模式下卡片已发送，跳过 markdown 消息`);
          return;
        }

        const accessToken = await this.dingtalkService.getAccessToken();
        const replyTitle = config.aiProvider === 'claude' ? 'Claude Code 回复' : 'AI 回复';

        if (result.success && result.data?.result) {
          const markdownText = preprocessDingTalkMarkdown(renderMarkdown(result.data.result));

          try {
            await this.dingtalkService.sendMarkdownMessage(accessToken, replyTitle, markdownText);
            // 触发消息已发送钩子
            hookRunner
              .trigger('message_sent' as HookEvent, {
                userId,
                userName,
                conversationId,
                content: result.data?.result?.substring(0, 200),
              })
              .catch(() => {});
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
      } catch (error: unknown) {
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
    // 初始化持久化会话池（同步等待 warmUp 完成，规避首条消息冷启动）
    if (config.persistentSession.enabled && config.aiProvider === 'claude') {
      try {
        await this.claudeCodeExecutor.initSessionPool({
          maxSessions: config.persistentSession.maxSessions,
          idleTimeout: config.persistentSession.idleTimeout,
        });
        console.log(
          `🚀 持久化会话池已启用 (最大 ${config.persistentSession.maxSessions} 会话，预热 ${config.persistentSession.warmUpSessions} 个 CLI 进程已就绪)`
        );
      } catch (warmupErr) {
        console.warn(
          `[Gateway] Claude CLI 预热失败: ${warmupErr instanceof Error ? warmupErr.message : String(warmupErr)}`
        );
        console.warn('[Gateway] 服务继续启动，但首条消息可能遇冷启动延迟');
      }
    }

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, host, () => {
        console.log(`🚀 Gateway 服务器已启动`);
        console.log(`   - 地址：http://${host}:${port}`);
        console.log(`   - 健康检查：http://${host}:${port}/health`);
        console.log(`   - 测试接口：http://${host}:${port}/api/test`);
        console.log(`   - 状态检查：http://${host}:${port}/api/status`);
        resolve();
      });

      this.server.on('error', error => {
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopConsumer();
    this.retrySender.stop();

    // 关闭持久化会话池
    await this.claudeCodeExecutor.closeSessionPool();

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
      } catch (error: unknown) {
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
    const { msg, userId = 'unknown', userName = '用户', sessionWebhook } = request;

    // 检查是否为 / 命令
    const parsedCommand = parseCommand(msg);
    if (parsedCommand) {
      console.log(`[Gateway] Command detected: /${parsedCommand.command} from ${userName}`);
      try {
        const response = await this.commandHandler.handle(parsedCommand, userId, '');
        return {
          success: true,
          message: '命令处理完成',
          data: { result: response },
        };
      } catch (error: unknown) {
        return {
          success: false,
          message: error instanceof Error ? error.message : '命令处理失败',
        };
      }
    }

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
    } catch (error: unknown) {
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
    } catch (error: unknown) {
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

      // 8.5 注入项目记忆上下文
      let memoryContext = '';
      if (this.memoryManager) {
        memoryContext = this.memoryManager.buildMemoryContext(msg);
        // 异步触发自动摘要（不阻塞消息处理）
        this.memoryManager.maybeSummarizeConversation(session.conversationId, userId).catch(err => {
          console.error('[Gateway] 自动摘要失败:', err);
        });
      }

      // 9. 构建 OpenCode 上下文
      const opencodeContext: MessageContext = {
        userId,
        userName,
        conversationId: session.conversationId,
        history,
        memoryContext: memoryContext || undefined,
      };

      // 10. 根据配置调用 AI 执行器
      const providerName = config.aiProvider === 'claude' ? 'Claude Code' : 'OpenCode';
      console.log(`[${messageId}] 步骤 6-9: 消息创建、历史构建完成，准备调用 ${providerName}`);

      let result;
      const useStreaming = config.streaming.enabled && this.streamingCardManager;
      const usePersistentSession =
        config.persistentSession.enabled && config.aiProvider === 'claude';

      if (useStreaming) {
        // 流式输出模式 - 使用 AI Card
        // conversationType 从 stream.ts 传递过来，用于区分群聊和单聊
        const senderType: 'group' | 'user' = request.conversationType || 'group';
        const streamHandle = await this.streamingCardManager!.startStream(
          session.conversationId,
          sessionWebhook || '',
          senderType,
          async (convId, title, text) => {
            try {
              // 优先使用 sessionWebhook 发送（无需 accessToken）
              if (sessionWebhook) {
                await axios.post(
                  sessionWebhook,
                  {
                    msgtype: 'markdown',
                    markdown: { title, text },
                  },
                  { timeout: 10000 }
                );
                return true;
              }
              // 降级：使用 dingtalkService 发送
              const accessToken = await this.dingtalkService.getAccessToken();
              await this.dingtalkService.sendMarkdownMessage(accessToken, title, text);
              return true;
            } catch {
              return false;
            }
          },
          async (convId, text) => {
            try {
              if (sessionWebhook) {
                await axios.post(
                  sessionWebhook,
                  {
                    msgtype: 'text',
                    text: { content: text },
                  },
                  { timeout: 10000 }
                );
                return true;
              }
              const accessToken = await this.dingtalkService.getAccessToken();
              await this.dingtalkService.sendTextMessage(accessToken, text);
              return true;
            } catch {
              return false;
            }
          },
          userId || ''
        );

        const displayFilter = new DisplayFilter();

        try {
          if (usePersistentSession) {
            // 持久化会话模式（消除冷启动）+ Display Filter
            // 注意：streamCallbacks 已包含 onText，不需要额外的 onChunk 回调
            result = await this.claudeCodeExecutor.executeSession(
              session.conversationId,
              msg,
              undefined,
              opencodeContext,
              {
                // eslint-disable-next-line @typescript-eslint/no-misused-promises
                onText: async (text: string) => {
                  console.log(
                    `[Gateway] onText callback fired: "${text.substring(0, 80).replace(/"/g, '\\"')}"`
                  );
                  const filtered = displayFilter.filter({ type: 'text', content: text });
                  if (filtered.shouldSend && filtered.content) {
                    console.log(
                      `[Gateway] onText: filtered.shouldSend=true, appending ${filtered.content.length} chars`
                    );
                    await streamHandle.appendChunk(filtered.content);
                    console.log(`[Gateway] onText: appendChunk done`);
                  } else {
                    console.log(`[Gateway] onText: filtered.shouldSend=false, skipping`);
                  }
                },
                // eslint-disable-next-line @typescript-eslint/no-misused-promises
                onThinking: async (text: string) => {
                  const filtered = displayFilter.filter({ type: 'thinking', content: text });
                  if (filtered.shouldSend && filtered.content) {
                    await streamHandle.appendChunk(filtered.content);
                  }
                },
                // eslint-disable-next-line @typescript-eslint/no-misused-promises
                onToolUse: async (name: string, input: Record<string, unknown>) => {
                  const filtered = displayFilter.filter({
                    type: 'tool_use',
                    content: JSON.stringify(input).substring(0, 200),
                    toolName: name,
                  });
                  if (filtered.shouldSend && filtered.content) {
                    await streamHandle.appendChunk(filtered.content);
                  }
                },
              }
            );
          } else if (config.aiProvider === 'claude') {
            result = await this.claudeCodeExecutor.executeStream(
              msg,
              async chunk => {
                const filtered = displayFilter.filter({ type: 'text', content: chunk });
                if (filtered.shouldSend && filtered.content) {
                  await streamHandle.appendChunk(filtered.content);
                }
              },
              opencodeContext
            );
          } else {
            result = await this.openCodeExecutor.executeStream(
              msg,
              async chunk => {
                await streamHandle.appendChunk(chunk);
              },
              opencodeContext
            );
          }
        } catch (error: unknown) {
          // AI 执行失败，记录错误并使用已积累的内容完成卡片
          console.error(`[${messageId}] 流式 AI 执行失败:`, error);
          const accumulatedText = streamHandle.getFullText() || 'AI 处理失败，请稍后重试';
          await streamHandle.finish(accumulatedText);
          // 提前返回，不执行后续逻辑
          return {
            success: false,
            message: 'AI 处理失败',
          };
        }

        // AI 执行成功，完成卡片
        // 先刷新 DisplayFilter 缓冲区（quiet 模式下累积的文本）
        const flushed = displayFilter.flush();
        if (flushed.shouldSend && flushed.content) {
          await streamHandle.appendChunk(flushed.content);
        }
        const finalText = result?.output || streamHandle.getFullText() || '处理完成';
        await streamHandle.finish(finalText);
      } else {
        // 非流式模式
        if (usePersistentSession) {
          result = await this.claudeCodeExecutor.executeSession(
            session.conversationId,
            msg,
            undefined,
            opencodeContext
          );
        } else if (config.aiProvider === 'claude') {
          result = await this.claudeCodeExecutor.execute(msg, opencodeContext);
        } else {
          result = await this.openCodeExecutor.execute(msg, opencodeContext);
        }
      }

      console.log(
        `[${messageId}] ${providerName} 完成: success=${result.success},  time=${result.executionTime}ms`
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
          streamingSent: !!useStreaming,
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

  /**
   * 销毁 Gateway，释放所有资源
   */
  destroy(): void {
    console.log('[Gateway] 正在销毁，释放资源...');

    // 停止队列消费
    if (this.consumerTimer) {
      clearInterval(this.consumerTimer);
      this.consumerTimer = null;
    }
    this.consumerRunning = false;

    // 停止重试发送器
    this.retrySender.stop();

    // 销毁并发控制器
    this.concurrencyController.destroy();

    // 停止限流器清理
    this.rateLimiter.stopCleanup();

    // 销毁消息队列
    this.messageQueue.destroy();

    // 销毁流式卡片管理器
    if (this.streamingCardManager) {
      this.streamingCardManager.destroy();
    }

    // 关闭 HTTP 服务器
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    console.log('[Gateway] 资源已释放');
  }
}
