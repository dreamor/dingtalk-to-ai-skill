/**
 * 应用入口
 * 
 * 核心功能：
 * 1. 初始化各模块（会话管理、消息队列、流量控制等）
 * 2. 启动 Gateway HTTP 服务
 * 3. 启动 Stream 模式接收钉钉消息
 * 4. 处理消息并调用 AI CLI
 */
import { config, validateConfig } from './config';
import { DingtalkService } from './dingtalk/dingtalk';
import { DingtalkStreamService } from './dingtalk/stream';
import { GatewayServer } from './gateway';
import { SessionManager } from './session-manager';
import { MessageQueue, RateLimiter, ConcurrencyController } from './message-queue';
import { MessageDeduplicator } from './utils/dedupCache';
import { OpenCodeExecutor } from './opencode';
import { 
  notifyServiceStart, 
  notifyServiceStop, 
  notifyError,
  isAlertEnabled,
  setStreamService 
} from './utils/alert';
import { enableGlobalSanitize } from './utils/logger';
import { Scheduler } from './scheduler';

// 全局服务引用，用于优雅关闭
let globalStreamService: DingtalkStreamService | null = null;
let globalGateway: GatewayServer | null = null;
let globalSessionManager: SessionManager | null = null;
let globalScheduler: Scheduler | null = null;

async function main(): Promise<void> {
  // 启用全局日志脱敏
  enableGlobalSanitize();

  console.log('🚀 启动钉钉 + AI 集成系统...');
  console.log('📦 所有消息将通过 AI CLI 处理');

  // 验证配置
  validateConfig();

  // 初始化基础模块
  const dingtalkService = new DingtalkService();
  const openCodeExecutor = new OpenCodeExecutor();

  // 检查 AI CLI 是否可用
  const opencodeAvailable = await openCodeExecutor.isAvailable();
  if (opencodeAvailable) {
    console.log('✅ AI CLI 可用');
  } else {
    console.log('⚠️ AI CLI 未安装，请先安装 opencode 或 claude');
  }

  // 初始化会话管理
  const sessionManager = new SessionManager({
    config: {
      ttl: config.session.ttl,
      maxHistoryMessages: config.session.maxHistoryMessages,
    },
    autoCleanup: true,
    cleanupInterval: 60000, // 1 分钟清理一次
  });
  globalSessionManager = sessionManager;

  // 初始化消息队列
  const messageQueue = new MessageQueue();

  // 初始化流量控制器
  const rateLimiter = new RateLimiter({
    maxTokens: config.messageQueue.rateLimitMaxTokens,
    refillRate: 1, // 每秒补充 1 个令牌
  });

  // 初始化并发控制器
  const concurrencyController = new ConcurrencyController({
    maxConcurrentPerUser: config.messageQueue.maxConcurrentPerUser,
    maxConcurrentGlobal: config.messageQueue.maxConcurrentGlobal,
  });

  // 初始化消息去重器
  const deduplicator = new MessageDeduplicator({
    maxSize: 1000,
    timeWindow: 60000,
  });

  console.log('✅ 基础模块初始化完成');
  console.log(`   - 会话管理器：已启动 (TTL: ${config.session.ttl / 1000 / 60}分钟)`);
  console.log(`   - 流量控制：已启动 (令牌：${config.messageQueue.rateLimitMaxTokens})`);
  console.log(`   - 并发控制：已启动 (用户：${config.messageQueue.maxConcurrentPerUser})`);
  console.log(`   - AI 超时：${config.ai.timeout / 1000}秒`);

  // 初始化定时任务调度器
  const scheduler = new Scheduler(config.scheduler);
  globalScheduler = scheduler;
  scheduler.setMessageQueue(messageQueue);
  await scheduler.init();
  if (config.scheduler.enabled) {
    console.log(`✅ 定时任务调度器已启动 (${scheduler.listTasks().length} 个任务)`);
  }

  // 创建 Gateway 服务
  const gateway = new GatewayServer(
    dingtalkService,
    {
      sessionManager,
      messageQueue,
      rateLimiter,
      concurrencyController,
      deduplicator,
      openCodeExecutor,
    }
  );
  globalGateway = gateway;

  // 启动 Gateway
  try {
    await gateway.start(config.gateway.port);
    console.log(`✅ Gateway 服务已启动，监听端口：${config.gateway.port}`);
      console.log(`   - 健康检查：http://${config.gateway.host}:${config.gateway.port}/health`);
      console.log(`   - 测试接口：http://${config.gateway.host}:${config.gateway.port}/api/test`);
      console.log(`   - 状态检查：http://${config.gateway.host}:${config.gateway.port}/api/status`);
    
      // 通知 PM2 服务已就绪
      if (process.send) {
        process.send('ready');
      }  } catch (error) {
    console.error('❌ 启动 Gateway 失败:', error);
    process.exit(1);
  }

  // 启动 Stream 模式（唯一模式）
  console.log('\n🌊 启动 Stream 模式（钉钉官方推荐，无需内网穿透）...');
  
  const streamService = new DingtalkStreamService();
  globalStreamService = streamService;
  
  // 设置消息处理器
  streamService.setMessageHandler(async (userId, userName, content, conversationId, sessionWebhook) => {
    const startTime = Date.now();
    console.log(`[Stream] 收到消息：${userName}(${userId}): ${content}`);
    console.log(`[Stream] conversationId: ${conversationId}`);
    console.log(`[Stream] sessionWebhook: ${sessionWebhook ? '✅ 有效' : '❌ 无效'}`);
    
    try {
      // 使用超时包装消息处理，防止长时间阻塞
      const processingTimeout = config.ai.timeout + 10000; // AI 超时 + 10秒缓冲
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`消息处理超时 (${processingTimeout / 1000}秒)`)), processingTimeout);
      });
      
      // 所有消息直接交给 AI 处理
      const result = await Promise.race([
        gateway.processMessage({
          msg: content,
          userId,
          userName,
        }),
        timeoutPromise
      ]);
      
      const processingTime = Date.now() - startTime;
      console.log(`[Stream] 消息处理完成，耗时: ${processingTime}ms`);
      
      // 使用 sessionWebhook 发送回复
      const replyTitle = config.aiProvider === 'claude' ? 'Claude Code 回复' : 'AI 回复';
      if (result.success && result.data?.result) {
        await streamService.sendMarkdownMessage(conversationId, replyTitle, result.data.result);
        console.log(`[Stream] ✅ 回复发送成功 (总耗时: ${Date.now() - startTime}ms)`);
      } else if (!result.success) {
        const errorMessage = `❌ ${result.message}`;
        await streamService.sendTextMessage(conversationId, errorMessage);
        console.log(`[Stream] ⚠️ 处理失败: ${result.message}`);
      }
    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error(`[Stream] 消息处理失败 (${processingTime}ms):`, error);
      const errorMessage = `❌ 消息处理失败\n\n错误：${error instanceof Error ? error.message : '未知错误'}`;
      
      try {
        await streamService.sendTextMessage(conversationId, errorMessage);
      } catch (sendError) {
        console.error('[Stream] 发送错误消息失败:', sendError);
      }
    }
  });

  // 启动 Stream 服务（内置重连机制）
  try {
    await streamService.start();
    console.log('✅ Stream 模式已启动');
    console.log('   - 无需内网穿透，钉钉会主动推送消息');
    console.log(`   - 自动重连: 已启用 (最多 ${config.stream.maxReconnectAttempts} 次)`);
    console.log('   - 在你的钉钉应用后台配置 Stream 模式即可');
    
    // 绑定 Stream 服务到告警模块
    setStreamService(streamService);
    
    // 发送服务启动通知
    if (isAlertEnabled()) {
      notifyServiceStart().catch(err => console.error('[Alert] 发送启动通知失败:', err));
    }
  } catch (error) {
    console.error('❌ Stream 模式启动失败:', error);
    console.error('   请检查网络连接和配置是否正确');
    process.exit(1);
  }
}

// 优雅关闭处理
async function cleanupResources(): Promise<void> {
  console.log('🧹 开始清理资源...');

  // 停止 Stream 服务
  if (globalStreamService) {
    try {
      console.log('   - 停止 Stream 服务...');
      await globalStreamService.stop();
      console.log('   ✅ Stream 服务已停止');
    } catch (error) {
      console.error('   ❌ 停止 Stream 服务时出错:', error);
    }
  }

  // 停止 Gateway
  if (globalGateway) {
    try {
      console.log('   - 停止 Gateway 服务...');
      await globalGateway.stop();
      console.log('   ✅ Gateway 服务已停止');
    } catch (error) {
      console.error('   ❌ 停止 Gateway 服务时出错:', error);
    }
  }

  // 清理会话管理器
  if (globalSessionManager) {
    try {
      console.log('   - 清理会话管理器...');
      globalSessionManager.stopCleanupService();
      console.log('   ✅ 会话管理器已清理');
    } catch (error) {
      console.error('   ❌ 清理会话管理器时出错:', error);
    }
  }

  // 停止调度器
  if (globalScheduler) {
    try {
      console.log('   - 停止调度器...');
      globalScheduler.stop();
      console.log('   ✅ 调度器已停止');
    } catch (error) {
      console.error('   ❌ 停止调度器时出错:', error);
    }
  }

  console.log('✅ 所有资源清理完成');
}

process.on('SIGINT', async () => {
  console.log('\n🛑 接收到关闭信号，正在清理...');
  if (isAlertEnabled()) {
    notifyServiceStop('收到 SIGINT 信号').catch(() => {});
  }
  await cleanupResources();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 接收到终止信号，正在清理...');
  if (isAlertEnabled()) {
    notifyServiceStop('收到 SIGTERM 信号').catch(() => {});
  }
  await cleanupResources();
  process.exit(0);
});

// 捕获未处理的 Promise 拒绝
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未处理的 Promise 拒绝:');
  console.error('   原因:', reason);
  console.error('   Promise:', promise);
  
  // 发送告警
  if (isAlertEnabled()) {
    const reasonStr = reason instanceof Error ? reason.message : String(reason);
    notifyError('未处理的 Promise 拒绝', reasonStr).catch(() => {});
  }
});

// 捕获未捕获的异常
process.on('uncaughtException', async (error) => {
  console.error('❌ 未捕获的异常:');
  console.error('   错误:', error.message);
  console.error('   堆栈:', error.stack);
  
  // 发送告警
  if (isAlertEnabled()) {
    await notifyError('未捕获的异常', error.message, error.stack).catch(() => {});
  }
  
  // 严重错误，清理后退出
  try {
    await cleanupResources();
  } catch (_e) {
    // ignore
  }
  process.exit(1);
});

main().catch((error) => {
  console.error('❌ 启动过程中发生错误:', error);
  process.exit(1);
});